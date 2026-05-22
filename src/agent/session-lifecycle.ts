import type { FieldDefinition } from '../harness/state-field.js'
import type { ProviderEntry } from '../harness/harness-builder.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { LoopResult } from '../loop/loop-executor.js'
import { runLoop } from '../loop/loop-executor.js'
import type { Observer } from './observer.js'
import {
  type SessionStore,
  type StoredRun,
  type StoredRunMetadata,
  type SessionPhase,
  initializeState,
  storedSessionToPhase,
} from './session-store.js'
import { StoreLoadError, LeaseExpiredError } from './concurrency-errors.js'
import { createKeepAliveFn, type LeaseRef } from './ctx-keep-alive.js'

// -----------------------------------------------------------------------
// SessionRunOptions — optional parameters for runWithSession
// -----------------------------------------------------------------------

export interface SessionRunOptions {
  /** Checked at the top of each loop iteration; returning true halts the run. */
  readonly shouldStop?: () => boolean
  /**
   * Called if the session store fails. `phase` is `'load'` (store failed at run start),
   * `'persist'` (store failed at run end/pause), or `'claim'` (claim returned null or threw).
   * Run result is still returned when phase is 'persist'.
   */
  readonly onStoreError?: (error: unknown, phase: 'load' | 'persist' | 'claim') => void
  /** Called just before each step executes. Used by RunHandle to track currentStep and fire onBeforeStep. */
  readonly onBeforeStep?: (name: string, state: Record<string, unknown>) => void
  /** Called after a step's run completes successfully and applyUpdate has been applied. */
  readonly onAfterStep?: (name: string, state: Record<string, unknown>) => void
  /** Called immediately when a step's run throws a non-interrupt error, before error routing. */
  readonly onError?: (error: unknown, stepName: string) => void
  /** Called when the loop exits via .on(signal).end() (paused: false). */
  readonly onComplete?: (state: Record<string, unknown>, signal: string) => void
  /** Called when ctx.interrupt() pauses the run (isInterruptPause is true). */
  readonly onInterrupt?: (prompt: unknown, interruptId: string) => void
  /** Listeners for user-emitted events (ctx.emit). Keyed by event name. */
  readonly listeners?: Record<string, (payload: unknown) => void>
  /** Structured telemetry observer for this run. All methods optional. F16b. */
  readonly observer?: Observer
  /**
   * Active lease reference. The factory closes over this ref; it is updated
   * in-place by `extendClaim()` calls. Absent when no claim is in use.
   */
  readonly leaseRef?: LeaseRef
  /**
   * The `instanceId` from `AgentOptions`, if provided. Written into
   * `StoredRun.metadata` on every terminal save and into `RunContext` for observers.
   */
  readonly instanceId?: string
  /**
   * The original claim `ttlMs` — passed to `createKeepAliveFn` as `originalTtlMs`
   * so `ctx.keepAlive()` uses the same TTL for renewals. Defaults to 30_000 when absent.
   */
  readonly claimTtlMs?: number
  /**
   * Optional parent run UUID — set when parentRunId was passed as a resource
   * to agent.run(). Threaded through to RunContext for cross-process trace
   * correlation. Absent for top-level runs.
   */
  readonly parentRunId?: string
}

// -----------------------------------------------------------------------
// resolveSessionStore — extract SessionStore from storeEntries
// -----------------------------------------------------------------------

export function resolveSessionStore(
  storeEntries: readonly ProviderEntry[],
): SessionStore | undefined {
  let result: SessionStore | undefined = undefined

  for (const entry of storeEntries) {
    if (entry.kind !== 'store') continue

    const value = entry.value
    if (value === null || typeof value !== 'object') continue

    const rec = value as Record<string, unknown> // as: TypeScript cannot narrow `object` to `Record<string, unknown>` for index access
    if (!('session' in rec)) continue

    const session = rec['session']
    if (session === null || typeof session !== 'object') continue

    const s = session as Record<string, unknown> // as: same narrowing needed to index into the duck-typed session object
    if (typeof s['load'] === 'function' && typeof s['save'] === 'function') {
      // last valid store wins
      result = session as unknown as SessionStore // as: duck-typing confirmed above; no instanceof available for a structural interface
    }
  }

  return result
}

// -----------------------------------------------------------------------
// querySessionPhase — implements agent.status() query
// -----------------------------------------------------------------------

export async function querySessionPhase(
  store: SessionStore | undefined,
  agentId: string,
  sessionId: string,
): Promise<SessionPhase> {
  if (store === undefined) {
    return { phase: 'fresh' }
  }

  const loaded = await store.load(agentId, sessionId)
  return storedSessionToPhase(loaded)
}

// -----------------------------------------------------------------------
// runWithSession — full session lifecycle wrapper around runLoop
// -----------------------------------------------------------------------

export async function runWithSession(
  store: SessionStore | undefined,
  agentId: string,
  sessionId: string,
  runId: string,
  graph: LoopDefinition,
  initialStateArg: Record<string, unknown>,
  schema: Record<string, FieldDefinition<any>> | undefined, // any: FieldDefinition uses invariant T; heterogeneous schema maps require any
  ctx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string },
  options?: SessionRunOptions,
): Promise<LoopResult> {
  // Inject keepAlive into ctx — no-op when no lease is active (leaseRef.current === null)
  const leaseRef = options?.leaseRef ?? { current: null }
  const keepAlive = createKeepAliveFn(leaseRef, store, options?.claimTtlMs ?? 30_000)
  ;(ctx as Record<string, unknown>)['keepAlive'] = keepAlive // mutate in-place like runLoop does for interrupt/emit

  // Build composedShouldStop — checks caller predicate AND lease expiry
  let leaseExpired = false
  const composedShouldStop = (): boolean => {
    if (options?.shouldStop?.() === true) return true
    if (leaseRef.current !== null && leaseRef.current.expiresAt <= Date.now()) {
      leaseExpired = true
      return true
    }
    return false
  }

  if (store === undefined) {
    const state = initializeState(null, initialStateArg, schema)
    const result = await runLoop(graph, state, ctx, schema, composedShouldStop, undefined, {
      ...options,
      runId,
      ...(options?.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
    })
    if (leaseExpired) {
      const expiredError = new LeaseExpiredError(sessionId)
      options?.onStoreError?.(expiredError, 'claim')
      throw expiredError
    }
    return result
  }

  // Load phase — on failure: fire onStoreError('load') and return synthetic error result
  // Run never begins; 'await run' always resolves (never rejects) per docs/agent.md guarantee
  let loaded: StoredRun | null
  try {
    loaded = await store.load(agentId, sessionId)
  } catch (error: unknown) {
    const storeError = new StoreLoadError(error)
    options?.onStoreError?.(storeError, 'load')
    const failState = initializeState(null, initialStateArg, schema)
    ;(failState as Record<string, unknown>)['$error'] = storeError
    return { state: failState, signal: '$error', paused: false, cursor: null }
  }

  // Short-circuit for completed sessions — return stored result immediately without executing
  if (loaded !== null && loaded.phase === 'completed') {
    return {
      state: loaded.finalState,
      signal: loaded.signal ?? null,
      cursor: null,
      paused: false,
    }
  }

  // Merge stored snapshot (or null for fresh) with caller-supplied initial state
  const state = initializeState(loaded, initialStateArg, schema)
  // Snapshot before runLoop — runLoop mutates state in place so we must copy before execution
  const initialStateSnapshot = { ...state }
  const startedAt = new Date().toISOString()

  // Execute — errors from runLoop propagate uncaught (except LeaseExpiredError handled below)
  const result = await runLoop(graph, state, ctx, schema, composedShouldStop, loaded?.step, {
    ...options,
    runId,
    ...(options?.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
  })

  // Lease-expired path — do NOT persist; signal error to caller
  if (leaseExpired) {
    const expiredError = new LeaseExpiredError(sessionId)
    options?.onStoreError?.(expiredError, 'claim')
    throw expiredError
  }

  const settledAt = new Date().toISOString()

  // Build optional metadata
  const metadata: StoredRunMetadata | undefined =
    options?.instanceId !== undefined ? { instanceId: options.instanceId } : undefined

  // Terminal save — errors are swallowed; LoopResult is always returned
  try {
    const version = (loaded?.version ?? -1) + 1
    if (result.paused) {
      const saved: StoredRun = {
        agentId,
        runId,
        sessionId,
        version,
        startedAt,
        settledAt,
        phase: 'paused',
        initialState: initialStateSnapshot,
        finalState: result.state,
        step: result.cursor!,
        ...(result.signal !== null ? { signal: result.signal } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      }
      await store.save(agentId, sessionId, saved)
    } else {
      const saved: StoredRun = {
        agentId,
        runId,
        sessionId,
        version,
        startedAt,
        settledAt,
        phase: 'completed',
        initialState: initialStateSnapshot,
        finalState: result.state,
        ...(result.signal !== null ? { signal: result.signal } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      }
      await store.save(agentId, sessionId, saved)
    }
  } catch (error) {
    options?.onStoreError?.(error, 'persist')
    // terminal save error is swallowed; LoopResult is returned to caller regardless
  }

  return result
}
