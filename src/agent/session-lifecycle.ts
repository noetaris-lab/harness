import type { FieldDefinition } from '../harness/state-field.js'
import type { ProviderEntry } from '../harness/harness-builder.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { LoopResult } from '../loop/loop-executor.js'
import { runLoop } from '../loop/loop-executor.js'
import {
  type SessionStore,
  type StoredSession,
  type SessionPhase,
  initializeState,
  storedSessionToPhase,
} from './session-store.js'
import { StoreLoadError } from './concurrency-errors.js'

// -----------------------------------------------------------------------
// SessionRunOptions — optional parameters for runWithSession
// -----------------------------------------------------------------------

export interface SessionRunOptions {
  /** Checked at the top of each loop iteration; returning true halts the run. */
  readonly shouldStop?: () => boolean
  /**
   * Called if the terminal phase save fails (phase: 'persist').
   * The run result is still returned after this callback fires.
   */
  readonly onStoreError?: (error: unknown, phase: 'load' | 'persist') => void
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
  sessionId: string,
): Promise<SessionPhase> {
  if (store === undefined) {
    return { phase: 'fresh' }
  }

  const loaded = await store.load(sessionId)
  return storedSessionToPhase(loaded)
}

// -----------------------------------------------------------------------
// runWithSession — full session lifecycle wrapper around runLoop
// -----------------------------------------------------------------------

export async function runWithSession(
  store: SessionStore | undefined,
  sessionId: string,
  graph: LoopDefinition,
  initialStateArg: Record<string, unknown>,
  schema: Record<string, FieldDefinition<any>> | undefined, // any: FieldDefinition uses invariant T; heterogeneous schema maps require any
  ctx: Record<string, unknown> & { readonly sessionId: string },
  options?: SessionRunOptions,
): Promise<LoopResult> {
  if (store === undefined) {
    const state = initializeState(null, initialStateArg, schema)
    return runLoop(graph, state, ctx, schema, options?.shouldStop, undefined, options)
  }

  // Load phase — on failure: fire onStoreError('load') and return synthetic error result
  // Run never begins; 'await run' always resolves (never rejects) per docs/agent.md guarantee
  let loaded: StoredSession | null
  try {
    loaded = await store.load(sessionId)
  } catch (error: unknown) {
    const storeError = new StoreLoadError(error)
    options?.onStoreError?.(storeError, 'load')
    const failState = initializeState(null, initialStateArg, schema)
    ;(failState as Record<string, unknown>)['$error'] = storeError
    return { state: failState, signal: '$error', paused: false, cursor: null }
  }

  // Merge stored snapshot (or null for fresh) with caller-supplied initial state
  const state = initializeState(loaded, initialStateArg, schema)

  // In-flight save: shallow copy captures state before runLoop mutates it in place
  const snapshot = { ...state }
  await store.save(sessionId, { phase: 'in-flight', state: snapshot })

  // Execute — errors from runLoop propagate uncaught
  const result = await runLoop(graph, state, ctx, schema, options?.shouldStop, loaded?.step, options)

  // Terminal save — errors are swallowed; LoopResult is always returned
  try {
    if (result.paused) {
      const saved: StoredSession = {
        phase: 'paused',
        state: result.state,
        step: result.cursor!,
        ...(result.signal !== null ? { signal: result.signal } : {}),
      }
      await store.save(sessionId, saved)
    } else {
      const saved: StoredSession = {
        phase: 'completed',
        state: result.state,
        ...(result.signal !== null ? { signal: result.signal } : {}),
      }
      await store.save(sessionId, saved)
    }
  } catch (error) {
    options?.onStoreError?.(error, 'persist')
    // terminal save error is swallowed; LoopResult is returned to caller regardless
  }

  return result
}
