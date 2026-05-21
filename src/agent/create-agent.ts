import {
  getInternals,
  type Harness,
  type HarnessInternals,
  type ProviderEntry,
} from '../harness/harness-builder.js'
import { isRequiredMarker, isRuntimeMarker } from '../harness/ctx-markers.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { FieldDefinition } from '../harness/state-field.js'
import type { SessionPhase, ClaimOptions, Lease } from './session-store.js'
import { resolveSessionStore, runWithSession, querySessionPhase, type SessionRunOptions } from './session-lifecycle.js'
import { runLoop } from '../loop/loop-executor.js'
import { createRunHandle, type RunHandle, type RunOutcome } from './run-handle.js'
import { NoInterruptError, injectInterruptResponse } from './interrupt-resume.js'
import {
  SessionInFlightError,
  SessionPendingInterruptError,
  SessionBusyError,
  LeaseExpiredError,
  StoreLoadError,
} from './concurrency-errors.js'
import type { LeaseRef } from './ctx-keep-alive.js'
import { randomUUID } from 'node:crypto'
import { extractRunEvents } from './event-callbacks.js'
import { extractRunListeners } from './ctx-emit.js'
import type { Observer } from './observer.js'
import { initializeState } from './session-store.js'

// -----------------------------------------------------------------------
// Module-level constants
// -----------------------------------------------------------------------

const NOOP_OBSERVER: Observer = {}

// -----------------------------------------------------------------------
// Module-private helpers
// -----------------------------------------------------------------------

function extractRunObserver(resources: Record<string, unknown>): Observer | undefined {
  const raw = resources['observer']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Observer // as: duck-typed plain object confirmed; methods not validated
}

/** Options passed to createAgent(). */
export interface AgentOptions {
  /**
   * Stable identifier for the process or replica running this agent instance.
   * Written to `StoredRun.metadata` on every save and propagated to observers
   * via `RunContext.instanceId`.
   */
  readonly instanceId?: string
}

// -----------------------------------------------------------------------
// Agent — the minimal public object returned by createAgent
// -----------------------------------------------------------------------

export interface Agent {
  /** The agent's unique identifier, as provided to createAgent(). */
  readonly id: string

  /**
   * Start a new run. Returns a RunHandle synchronously before execution begins.
   */
  run(initialState: Record<string, unknown>, resources: Record<string, unknown>): RunHandle

  /**
   * Cross-process entry point for responding to a pending interrupt.
   * Returns a RunHandle synchronously; the execution promise performs the resume.
   */
  resume(
    response: unknown,
    sessionId: string,
    interruptId: string,
    options?: { events?: { onStoreError?: (error: unknown, phase: 'load' | 'persist' | 'claim') => void } },
  ): RunHandle

  /**
   * Query the session store for the current phase of a session.
   */
  status(sessionId: string): Promise<SessionPhase>
}

// -----------------------------------------------------------------------
// AgentInternals — the resolved internal state
// -----------------------------------------------------------------------

export interface AgentInternals {
  readonly agentId: string
  readonly resolvedProviders: ReadonlyMap<string, unknown>
  readonly storeEntries: readonly ProviderEntry[]
  readonly loopDef: LoopDefinition
  readonly stateSchema: Record<string, FieldDefinition<unknown>> | undefined
  /** Keys declared as runtime() in the harness — must be filled in agent.run() resources. */
  readonly runtimeKeys: ReadonlySet<string>
  /** Keys declared as required() in the harness — must NOT appear in agent.run() resources. */
  readonly requiredKeys: ReadonlySet<string>
}

// -----------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------

/** Thrown by {@link createAgent} when the harness has no `.loop()` declaration. */
export class MissingLoopError extends Error {
  constructor() {
    super('harness has no loop — call h.loop() before createAgent(id, h, slots)')
    this.name = 'MissingLoopError'
  }
}

/** Thrown by {@link createAgent} when a `required()` slot is absent from `slots`. */
export class MissingSlotError extends Error {
  /** The missing slot key. */
  readonly key: string

  constructor(key: string) {
    super(`required slot "${key}" was not provided in createAgent slots`)
    this.name = 'MissingSlotError'
    this.key = key
  }
}

/** Thrown by {@link createAgent} when a `runtime()` slot is passed in `slots` instead of `agent.run()`. */
export class RuntimeSlotInAgentError extends Error {
  /** The offending slot key. */
  readonly key: string

  constructor(key: string) {
    super(`slot "${key}" is a runtime() slot — provide it in agent.run(), not createAgent()`)
    this.name = 'RuntimeSlotInAgentError'
    this.key = key
  }
}

/** Thrown by {@link createAgent} when `slots` contains a key not declared in the harness. */
export class UnknownSlotError extends Error {
  /** The unknown slot key. */
  readonly key: string

  constructor(key: string) {
    super(`slot "${key}" is not declared in the harness — remove it or add h.provide("${key}", required())`)
    this.name = 'UnknownSlotError'
    this.key = key
  }
}

/** @internal Thrown when `getAgentInternals` is called on a non-agent value. */
export class AgentInternalsError extends Error {
  constructor() {
    super('value was not produced by createAgent — cannot read AgentInternals')
    this.name = 'AgentInternalsError'
  }
}

/** Thrown by {@link Agent.run} when a `runtime()` slot is absent from `resources`. */
export class MissingRuntimeSlotError extends Error {
  /** The missing runtime slot key. */
  readonly key: string
  constructor(key: string) {
    super(`runtime slot "${key}" was not provided in agent.run() resources`)
    this.name = 'MissingRuntimeSlotError'
    this.key = key
  }
}

/** Thrown by {@link Agent.run} when a `required()` slot is passed in `resources` instead of `createAgent()`. */
export class RequiredSlotInRunError extends Error {
  /** The offending slot key. */
  readonly key: string
  constructor(key: string) {
    super(`slot "${key}" is a required() slot — provide it in createAgent(), not agent.run()`)
    this.name = 'RequiredSlotInRunError'
    this.key = key
  }
}

/** Thrown by {@link Agent.run} when `resources` contains a key that was not declared as `runtime()`. */
export class UnknownRunSlotError extends Error {
  /** The unknown resource key. */
  readonly key: string
  constructor(key: string) {
    super(`slot "${key}" is not a runtime() slot — do not pass it in agent.run() resources`)
    this.name = 'UnknownRunSlotError'
    this.key = key
  }
}

// -----------------------------------------------------------------------
// Module-private symbol for AttachInternals
// -----------------------------------------------------------------------

const _agentInternals = Symbol('_agentInternals')

type AgentWithInternals = Agent & {
  readonly [_agentInternals]: AgentInternals
}

// -----------------------------------------------------------------------
// createAgent — the public factory
// -----------------------------------------------------------------------

/**
 * Instantiate an agent from a fully-configured {@link Harness}.
 *
 * Validates that all `required()` slots are present in `slots`, that no
 * `runtime()` slots are passed here, and that the harness has a loop defined.
 *
 * @param id - A stable, human-readable identifier for this agent (used as the
 *   first argument to every store operation).
 * @param h - The harness produced by `createHarness()...loop()`.
 * @param slots - Values for every slot declared with `required()` in the harness.
 * @param options - Optional agent-level options (e.g., instanceId).
 *
 * @throws {@link MissingLoopError} when `h.loop()` was never called.
 * @throws {@link MissingSlotError} when a `required()` slot is absent from `slots`.
 * @throws {@link RuntimeSlotInAgentError} when a `runtime()` slot is passed in `slots`.
 * @throws {@link UnknownSlotError} when `slots` contains a key not declared in the harness.
 *
 * @example
 * ```ts
 * const agent = createAgent('my-agent', h, { llm: new Claude('claude-3-5-haiku-20241022') })
 * const handle = agent.run({}, {})
 * const { state, signal } = await handle
 * ```
 */
export function createAgent<Ctx, State, Req extends keyof Ctx, Run extends keyof Ctx>(
  id: string,
  h: Harness<Ctx, State, Req, Run>,
  slots: Pick<Ctx, Req>,
  agentOptions?: AgentOptions,
): Agent {
  // Get harness internals; propagate HarnessInternalsError if h is not a real Harness
  const internals: HarnessInternals<Ctx, State, Req, Run> = getInternals(h)

  // Validation 1: loop exists
  if (internals.loopDef === undefined) {
    throw new MissingLoopError()
  }

  // Build a map of provider entries with kind 'provide' for slot validation
  const providerMap = new Map<string, ProviderEntry>()
  for (const entry of internals.providers) {
    if (entry.kind === 'provide') {
      providerMap.set(entry.key, entry)
    }
  }

  // Validation 2: no unknown keys in slots
  for (const key of Object.keys(slots)) {
    if (!providerMap.has(key)) {
      throw new UnknownSlotError(key)
    }
  }

  // Validation 3: no runtime() markers in slots
  for (const key of Object.keys(slots)) {
    const entry = providerMap.get(key)
    if (entry && isRuntimeMarker(entry.value)) {
      throw new RuntimeSlotInAgentError(key)
    }
  }

  // Validation 4: all required() slots are provided
  for (const entry of internals.providers) {
    if (entry.kind === 'provide' && isRequiredMarker(entry.value)) {
      if (!(entry.key in slots)) {
        throw new MissingSlotError(entry.key)
      }
    }
  }

  // Build resolvedProviders map: iterate all providers in order, last-registered-wins
  const resolvedProviders = new Map<string, unknown>()
  const storeEntries: ProviderEntry[] = []
  const runtimeKeys = new Set<string>()
  const requiredKeys = new Set<string>()

  for (const entry of internals.providers) {
    if (entry.kind === 'store') {
      storeEntries.push(entry)
    } else if (entry.kind === 'provide') {
      if (isRequiredMarker(entry.value)) {
        // Replace required() marker with the slot value
        resolvedProviders.set(entry.key, (slots as Record<string, unknown>)[entry.key]) // as: Req extends keyof Ctx erases to plain index at runtime
        requiredKeys.add(entry.key)
      } else if (isRuntimeMarker(entry.value)) {
        runtimeKeys.add(entry.key)
        // runtime() markers are not included in resolvedProviders
      } else {
        // Concrete value: include as-is
        resolvedProviders.set(entry.key, entry.value)
      }
    }
  }

  // Resolve session store from store entries at construction time
  const capturedStore = resolveSessionStore(storeEntries)

  // Construct AgentInternals
  const agentInternals: AgentInternals = {
    agentId: id,
    resolvedProviders,
    storeEntries,
    loopDef: internals.loopDef, // Guaranteed to be non-undefined by validation 1
    stateSchema: internals.stateSchema,
    runtimeKeys,
    requiredKeys,
  }

  // Reserved keys are skipped during agent.run() resource validation
  const reservedRunKeys = new Set(['sessionId', 'signal', 'events', 'listeners', 'observer', 'claimOptions'])

  // one per agent instance; tracks all session IDs currently executing
  const inFlightSessions = new Set<string>()

  // one per agent instance; tracks session IDs paused on an unanswered interrupt
  // cleared when agent.resume() or run.resume() is called; populated when a run settles with signal: "$interrupt"
  const interruptPendingSessions = new Set<string>()

  // -----------------------------------------------------------------------
  // makeAgentResumeHandle — factory for cross-process resume RunHandles
  // -----------------------------------------------------------------------

  const makeAgentResumeHandle = (
    resp: unknown,
    sId: string,
    iId: string,
    resumeOpts?: { onStoreError?: (error: unknown, phase: 'load' | 'persist' | 'claim') => void },
  ): RunHandle => {
    const flag = { stopped: false }
    const ref: { current: string | null } = { current: null }
    const rId = randomUUID()

    const exec = (async (): Promise<RunOutcome> => {
      await Promise.resolve()
      const claimOptions: ClaimOptions = { ttlMs: 30_000 }
      let leaseRef: LeaseRef | undefined = undefined
      try {
        if (typeof capturedStore?.claim === 'function') {
          let lease: Lease | null
          try {
            lease = await capturedStore.claim(id, sId, claimOptions)
          } catch (claimError: unknown) {
            const loadError = new StoreLoadError(claimError)
            resumeOpts?.onStoreError?.(loadError, 'claim')
            const failState = initializeState(null, {}, agentInternals.stateSchema)
            ;(failState as Record<string, unknown>)['$error'] = loadError
            return { state: failState, signal: '$error' }
          }
          if (lease === null) {
            const busyError = new SessionBusyError(sId)
            resumeOpts?.onStoreError?.(busyError, 'claim')
            const failState = initializeState(null, {}, agentInternals.stateSchema)
            ;(failState as Record<string, unknown>)['$error'] = busyError
            return { state: failState, signal: '$error' }
          }
          leaseRef = { current: lease }
        }
        try {
          if (capturedStore === undefined) throw new NoInterruptError()
          await injectInterruptResponse(capturedStore, id, sId, iId, resp)
          const agentCtx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string } = {
            ...Object.fromEntries(agentInternals.resolvedProviders),
            agentId: id,
            sessionId: sId,
          }
          const r = await runWithSession(
            capturedStore,
            id,
            sId,
            rId,
            agentInternals.loopDef,
            {},
            agentInternals.stateSchema,
            agentCtx,
            {
              shouldStop: () => flag.stopped,
              onBeforeStep: (n: string) => { ref.current = n },
              ...(resumeOpts?.onStoreError !== undefined ? { onStoreError: resumeOpts.onStoreError } : {}),
              ...(leaseRef !== undefined ? { leaseRef, claimTtlMs: claimOptions.ttlMs } : {}),
            },
          )
          if (r.signal === '$interrupt') interruptPendingSessions.add(sId)
          return { state: r.state, signal: r.signal }
        } catch (error: unknown) {
          if (error instanceof LeaseExpiredError) {
            const failState = initializeState(null, {}, agentInternals.stateSchema)
            ;(failState as Record<string, unknown>)['$error'] = error
            return { state: failState, signal: '$error' }
          }
          throw error
        } finally {
          if (leaseRef !== undefined && typeof capturedStore?.release === 'function') {
            try { await capturedStore.release(leaseRef.current!) } catch { /* swallow */ }
          }
        }
      } finally {
        inFlightSessions.delete(sId)
      }
    })()

    const resumeFn = (r: unknown, i: string): RunHandle => {
      // Synchronous fence — same invariant as agent.resume()
      if (inFlightSessions.has(sId)) throw new SessionInFlightError(sId)
      interruptPendingSessions.delete(sId)
      inFlightSessions.add(sId)
      return makeAgentResumeHandle(r, sId, i)
    }
    return createRunHandle(sId, rId, exec, flag, ref, resumeFn)
  }

  // Create and return Agent with attached internals
  const agent: AgentWithInternals = {
    id,
    run: (initialState: Record<string, unknown>, resources: Record<string, unknown>): RunHandle => {
      // Validation pass 1: unknown keys (not reserved, not runtime, not required)
      for (const key of Object.keys(resources)) {
        if (reservedRunKeys.has(key)) continue
        if (!agentInternals.runtimeKeys.has(key) && !agentInternals.requiredKeys.has(key)) {
          throw new UnknownRunSlotError(key)
        }
      }

      // Validation pass 2: required() keys passed in resources
      for (const key of Object.keys(resources)) {
        if (reservedRunKeys.has(key)) continue
        if (agentInternals.requiredKeys.has(key)) {
          throw new RequiredSlotInRunError(key)
        }
      }

      // Validation pass 3: missing runtime() keys
      for (const key of agentInternals.runtimeKeys) {
        if (!(key in resources)) {
          throw new MissingRuntimeSlotError(key)
        }
      }

      // Session ID resolution
      const sessionId =
        typeof resources['sessionId'] === 'string' ? resources['sessionId'] : randomUUID()

      // Run ID — unique per agent.run() invocation, available synchronously on RunHandle
      const runId = randomUUID()

      // Synchronous concurrency fences — must precede any await (per docs/agent.md Concurrency section)
      if (inFlightSessions.has(sessionId)) throw new SessionInFlightError(sessionId)
      if (interruptPendingSessions.has(sessionId)) throw new SessionPendingInterruptError(sessionId)
      inFlightSessions.add(sessionId)

      // AbortSignal wiring — register first to avoid race, then check already-aborted state
      const stopFlag = { stopped: false }
      const rawSignal = resources['signal']
      if (rawSignal instanceof AbortSignal) {
        rawSignal.addEventListener('abort', () => { stopFlag.stopped = true }, { once: true })
        if (rawSignal.aborted) stopFlag.stopped = true
      }

      // Fresh stepRef per call for currentStep tracking
      const stepRef: { current: string | null } = { current: null }

      // Assemble ctx: resolvedProviders merged with runtime slots and sessionId
      const runtimeSlots: Record<string, unknown> = {}
      for (const key of agentInternals.runtimeKeys) {
        if (reservedRunKeys.has(key)) continue // reserved keys are consumed by framework, not injected into ctx
        runtimeSlots[key] = resources[key]
      }
      const ctx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string } = {
        ...Object.fromEntries(agentInternals.resolvedProviders),
        ...runtimeSlots,
        agentId: id,
        sessionId,
        ...(agentOptions?.instanceId !== undefined ? { instanceId: agentOptions.instanceId } : {}),
      }

      // Extract event callbacks and listeners from resources (reserved keys)
      const events = extractRunEvents(resources)
      const listeners = extractRunListeners(resources)

      // Extract observer and bind to any ObserverAware slots synchronously before async execution begins
      const observer = extractRunObserver(resources)
      for (const slot of [...agentInternals.resolvedProviders.values(), ...Object.values(runtimeSlots)]) {
        if (slot !== null && typeof slot === 'object' && typeof (slot as Record<string, unknown>)['bindObserver'] === 'function') { // as: duck-typed structural check; slot typed as unknown at this point
          (slot as { bindObserver: (o: Observer) => void }).bindObserver(observer ?? NOOP_OBSERVER) // as: narrowed by duck-type check on line above
        }
      }

      const options: SessionRunOptions = {
        shouldStop: () => stopFlag.stopped,
        onBeforeStep: (name: string, state: Record<string, unknown>) => {
          stepRef.current = name
          events.onBeforeStep?.(name, state)
        },
        // spread optional event callbacks only when defined (exactOptionalPropertyTypes requires omission, not undefined)
        ...(events.onStoreError !== undefined ? { onStoreError: events.onStoreError } : {}),
        ...(events.onAfterStep !== undefined ? { onAfterStep: events.onAfterStep } : {}),
        ...(events.onError !== undefined ? { onError: events.onError } : {}),
        ...(events.onComplete !== undefined ? { onComplete: events.onComplete } : {}),
        ...(events.onInterrupt !== undefined ? { onInterrupt: events.onInterrupt } : {}),
        ...(Object.keys(listeners).length > 0 ? { listeners } : {}),
        ...(observer !== undefined ? { observer } : {}),
        ...(agentOptions?.instanceId !== undefined ? { instanceId: agentOptions.instanceId } : {}),
      }

      // lastResult captures the LoopResult for same-process in-memory resume chaining
      let lastResult: { state: Record<string, unknown>; cursor: string | null } | null = null

      // Launch execution asynchronously — agent.run() returns before any async work begins
      const execution = (async (): Promise<RunOutcome> => {
        // Yield so agent.run() can return the RunHandle before any loop iteration starts
        await Promise.resolve()

        // Parse claimOptions from resources (reserved key); default ttlMs=30_000
        const rawClaimOpts = resources['claimOptions']
        const claimOptions: ClaimOptions =
          typeof rawClaimOpts === 'object' && rawClaimOpts !== null &&
          typeof (rawClaimOpts as Record<string, unknown>)['ttlMs'] === 'number'
            ? (rawClaimOpts as ClaimOptions)
            : { ttlMs: 30_000 }

        let leaseRef: LeaseRef | undefined = undefined

        try {
          if (typeof capturedStore?.claim === 'function') {
            let lease: Lease | null
            try {
              lease = await capturedStore.claim(id, sessionId, claimOptions)
            } catch (claimError: unknown) {
              const loadError = new StoreLoadError(claimError)
              events.onStoreError?.(loadError, 'claim')
              const failState = initializeState(null, initialState, agentInternals.stateSchema)
              ;(failState as Record<string, unknown>)['$error'] = loadError
              return { state: failState, signal: '$error' }
            }
            if (lease === null) {
              const busyError = new SessionBusyError(sessionId)
              events.onStoreError?.(busyError, 'claim')
              const failState = initializeState(null, initialState, agentInternals.stateSchema)
              ;(failState as Record<string, unknown>)['$error'] = busyError
              return { state: failState, signal: '$error' }
            }
            leaseRef = { current: lease }
          }
          try {
            const r = await runWithSession(
              capturedStore,
              id,
              sessionId,
              runId,
              agentInternals.loopDef,
              initialState,
              agentInternals.stateSchema,
              ctx,
              {
                ...options,
                ...(leaseRef !== undefined ? { leaseRef, claimTtlMs: claimOptions.ttlMs } : {}),
              },
            )
            if (r.signal === '$interrupt') interruptPendingSessions.add(sessionId)
            lastResult = { state: r.state, cursor: r.cursor }
            return { state: r.state, signal: r.signal }
          } catch (error: unknown) {
            if (error instanceof LeaseExpiredError) {
              // onStoreError already called by runWithSession before throwing
              const failState = initializeState(null, initialState, agentInternals.stateSchema)
              ;(failState as Record<string, unknown>)['$error'] = error
              return { state: failState, signal: '$error' }
            }
            throw error
          } finally {
            if (leaseRef !== undefined && typeof capturedStore?.release === 'function') {
              try { await capturedStore.release(leaseRef.current!) } catch { /* swallow */ }
            }
          }
        } finally {
          inFlightSessions.delete(sessionId)
        }
      })()

      // buildResumeFn — creates a recursive resumeFn for same-process chaining via run.resume()
      const buildResumeFn = (): ((response: unknown, interruptId: string) => RunHandle) => {
        return (response: unknown, interruptId: string): RunHandle => {
          // Synchronous fence — same invariant as agent.run()
          if (inFlightSessions.has(sessionId)) throw new SessionInFlightError(sessionId)
          interruptPendingSessions.delete(sessionId)
          inFlightSessions.add(sessionId)

          const resumeStopFlag = { stopped: false }
          const resumeStepRef: { current: string | null } = { current: null }
          const resumeRunId = randomUUID()

          const resumeExecution = (async (): Promise<RunOutcome> => {
            await Promise.resolve()
            try {
              if (capturedStore !== undefined) {
                // Cross-process path: inject response into store, reload, and re-run
                await injectInterruptResponse(capturedStore, id, sessionId, interruptId, response)
                const r = await runWithSession(
                  capturedStore,
                  id,
                  sessionId,
                  resumeRunId,
                  agentInternals.loopDef,
                  {},
                  agentInternals.stateSchema,
                  ctx,
                  {
                    shouldStop: () => resumeStopFlag.stopped,
                    onBeforeStep: (n: string, s: Record<string, unknown>) => {
                      resumeStepRef.current = n
                      events.onBeforeStep?.(n, s)
                    },
                    // spread optional event callbacks only when defined (exactOptionalPropertyTypes requires omission, not undefined)
                    ...(events.onStoreError !== undefined ? { onStoreError: events.onStoreError } : {}),
                    ...(events.onAfterStep !== undefined ? { onAfterStep: events.onAfterStep } : {}),
                    ...(events.onError !== undefined ? { onError: events.onError } : {}),
                    ...(events.onComplete !== undefined ? { onComplete: events.onComplete } : {}),
                    ...(events.onInterrupt !== undefined ? { onInterrupt: events.onInterrupt } : {}),
                    ...(Object.keys(listeners).length > 0 ? { listeners } : {}),
                  },
                )
                if (r.signal === '$interrupt') interruptPendingSessions.add(sessionId)
                lastResult = { state: r.state, cursor: r.cursor }
                return { state: r.state, signal: r.signal }
              }

              // Same-process in-memory path: mutate shared state and re-run from cursor
              const prev = lastResult
              if (prev === null) throw new NoInterruptError()
              const state = prev.state
              const existing = (state.$interruptResponses as Record<string, unknown>) ?? {}
              state.$interruptResponses = { ...existing, [interruptId]: response }
              state.$interrupt = null
              const cursor = prev.cursor ?? undefined
              const r = await runLoop(
                agentInternals.loopDef,
                state,
                ctx,
                agentInternals.stateSchema,
                () => resumeStopFlag.stopped,
                cursor,
                {
                  onBeforeStep: (n: string, s: Record<string, unknown>) => {
                    resumeStepRef.current = n
                    events.onBeforeStep?.(n, s)
                  },
                  ...(events.onAfterStep !== undefined ? { onAfterStep: events.onAfterStep } : {}),
                  ...(events.onError !== undefined ? { onError: events.onError } : {}),
                  ...(events.onComplete !== undefined ? { onComplete: events.onComplete } : {}),
                  ...(events.onInterrupt !== undefined ? { onInterrupt: events.onInterrupt } : {}),
                  ...(Object.keys(listeners).length > 0 ? { listeners } : {}),
                },
              )
              if (r.signal === '$interrupt') interruptPendingSessions.add(sessionId)
              lastResult = { state: r.state, cursor: r.cursor }
              return { state: r.state, signal: r.signal }
            } catch (error: unknown) {
              if (error instanceof LeaseExpiredError) {
                // onStoreError already called by runWithSession before throwing
                const failState = initializeState(null, initialState, agentInternals.stateSchema)
                ;(failState as Record<string, unknown>)['$error'] = error
                return { state: failState, signal: '$error' }
              }
              throw error
            } finally {
              inFlightSessions.delete(sessionId)
            }
          })()

          return createRunHandle(sessionId, resumeRunId, resumeExecution, resumeStopFlag, resumeStepRef, buildResumeFn())
        }
      }

      return createRunHandle(sessionId, runId, execution, stopFlag, stepRef, buildResumeFn())
    },

    resume: (
      response: unknown,
      sessionId: string,
      interruptId: string,
      resumeOptions?: { events?: { onStoreError?: (error: unknown, phase: 'load' | 'persist' | 'claim') => void } },
    ): RunHandle => {
      if (inFlightSessions.has(sessionId)) throw new SessionInFlightError(sessionId)
      interruptPendingSessions.delete(sessionId)
      inFlightSessions.add(sessionId)
      const resumeOpts = resumeOptions?.events?.onStoreError !== undefined
        ? { onStoreError: resumeOptions.events.onStoreError }
        : undefined
      return makeAgentResumeHandle(response, sessionId, interruptId, resumeOpts)
    },

    status: (sessionId: string) => querySessionPhase(capturedStore, id, sessionId),
    [_agentInternals]: agentInternals,
  }

  return agent
}

// -----------------------------------------------------------------------
// getAgentInternals — accessor for AgentInternals
// -----------------------------------------------------------------------

export function getAgentInternals(agent: Agent): AgentInternals {
  if (agent === null || typeof agent !== 'object' || !(_agentInternals in agent)) {
    throw new AgentInternalsError()
  }
  return (agent as AgentWithInternals)[_agentInternals] // as: _agentInternals in agent guard above guarantees the symbol key is present
}
