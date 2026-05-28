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
import type { Observer, StepContext } from './observer.js'
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
   *
   * The optional fourth argument `resources` accepts:
   * - `observer?: Observer` — structured telemetry for the resumed run (see Observability)
   * - `events?.onStoreError?` — raw store-error callback (unchanged from prior shape)
   */
  resume(
    response: unknown,
    sessionId: string,
    interruptId: string,
    resources?: Record<string, unknown>,
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
  const reservedRunKeys = new Set(['sessionId', 'signal', 'events', 'listeners', 'observer', 'claimOptions', 'parentRunId'])

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
    observer?: Observer,
    setStepContextSlots?: ReadonlyArray<{ setStepContext(ctx: StepContext): void }>,
  ): RunHandle => {
    let _stopped = false
    const abortController = new AbortController()
    const flag = {
      get stopped(): boolean { return _stopped },
      set stopped(v: boolean) { _stopped = v; if (v) abortController.abort() },
    }
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
          try {
            await injectInterruptResponse(capturedStore, id, sId, iId, resp)
          } catch (injectError: unknown) {
            if (injectError instanceof NoInterruptError) throw injectError
            // store I/O failure during interrupt injection — report as 'claim' phase error
            const storeError = new StoreLoadError(injectError)
            resumeOpts?.onStoreError?.(storeError, 'claim')
            const failState = initializeState(null, {}, agentInternals.stateSchema)
            ;(failState as Record<string, unknown>)['$error'] = storeError
            return { state: failState, signal: '$error' }
          }
          const agentCtx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string; readonly runId: string; readonly signal: AbortSignal } = {
            ...Object.fromEntries(agentInternals.resolvedProviders),
            agentId: id,
            sessionId: sId,
            runId: rId,
            signal: abortController.signal,
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
              ...(observer !== undefined ? { observer } : {}),
              ...(setStepContextSlots !== undefined && setStepContextSlots.length > 0 ? { setStepContextSlots } : {}),
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

      // AbortSignal and stop-flag wiring
      let _stopped = false
      const abortController = new AbortController()
      const stopFlag = {
        get stopped(): boolean { return _stopped },
        set stopped(v: boolean) { _stopped = v; if (v) abortController.abort() },
      }
      const rawSignal = resources['signal']
      let ctxSignal: AbortSignal = abortController.signal
      if (rawSignal instanceof AbortSignal) {
        ctxSignal = rawSignal
        rawSignal.addEventListener('abort', () => { stopFlag.stopped = true; abortController.abort() }, { once: true })
        if (rawSignal.aborted) stopFlag.stopped = true
      }

      // Fresh stepRef per call for currentStep tracking
      const stepRef: { current: string | null } = { current: null }

      // Assemble ctx: resolvedProviders merged with runtime slots and sessionId, runId, and signal
      const runtimeSlots: Record<string, unknown> = {}
      for (const key of agentInternals.runtimeKeys) {
        if (reservedRunKeys.has(key)) continue // reserved keys are consumed by framework, not injected into ctx
        runtimeSlots[key] = resources[key]
      }
      const ctx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string; readonly runId: string; readonly signal: AbortSignal } = {
        ...Object.fromEntries(agentInternals.resolvedProviders),
        ...runtimeSlots,
        agentId: id,
        sessionId,
        runId,
        signal: ctxSignal,
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

      // Build setStepContextSlots: pre-filter all slots that expose setStepContext (F36)
      const setStepContextSlots: Array<{ setStepContext(ctx: StepContext): void }> = []
      for (const slot of [...agentInternals.resolvedProviders.values(), ...Object.values(runtimeSlots)]) {
        if (
          slot !== null &&
          typeof slot === 'object' &&
          typeof (slot as Record<string, unknown>)['setStepContext'] === 'function' // as: duck-type check
        ) {
          setStepContextSlots.push(slot as { setStepContext(ctx: StepContext): void }) // as: narrowed by duck-type check on line above
        }
      }

      // Extract parentRunId from resources (reserved key)
      const parentRunId =
        typeof resources['parentRunId'] === 'string' ? resources['parentRunId'] : undefined

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
        ...(parentRunId !== undefined ? { parentRunId } : {}),
        ...(setStepContextSlots.length > 0 ? { setStepContextSlots } : {}),
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

          let _resumeStopped = false
          const resumeAbortController = new AbortController()
          const resumeStopFlag = {
            get stopped(): boolean { return _resumeStopped },
            set stopped(v: boolean) { _resumeStopped = v; if (v) resumeAbortController.abort() },
          }
          const resumeStepRef: { current: string | null } = { current: null }
          const resumeRunId = randomUUID()

          const resumeExecution = (async (): Promise<RunOutcome> => {
            await Promise.resolve()
            try {
              // Create a new ctx for this resume invocation with updated runId and signal
              const resumeCtx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string; readonly runId: string; readonly signal: AbortSignal } = {
                ...ctx,
                runId: resumeRunId,
                signal: resumeAbortController.signal,
              }

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
                  resumeCtx,
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
                    ...(observer !== undefined ? { observer } : {}),
                    ...(setStepContextSlots.length > 0 ? { setStepContextSlots } : {}),
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
                resumeCtx,
                agentInternals.stateSchema,
                () => resumeStopFlag.stopped,
                cursor,
                {
                  runId: resumeRunId,
                  onBeforeStep: (n: string, s: Record<string, unknown>) => {
                    resumeStepRef.current = n
                    events.onBeforeStep?.(n, s)
                  },
                  ...(events.onAfterStep !== undefined ? { onAfterStep: events.onAfterStep } : {}),
                  ...(events.onError !== undefined ? { onError: events.onError } : {}),
                  ...(events.onComplete !== undefined ? { onComplete: events.onComplete } : {}),
                  ...(events.onInterrupt !== undefined ? { onInterrupt: events.onInterrupt } : {}),
                  ...(Object.keys(listeners).length > 0 ? { listeners } : {}),
                  ...(observer !== undefined ? { observer } : {}),
                  ...(setStepContextSlots.length > 0 ? { setStepContextSlots } : {}),
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
      resources?: Record<string, unknown>,
    ): RunHandle => {
      // SessionInFlightError fence is first — before any extraction or binding (Invariant 3)
      if (inFlightSessions.has(sessionId)) throw new SessionInFlightError(sessionId)
      interruptPendingSessions.delete(sessionId)
      inFlightSessions.add(sessionId)
      const events = extractRunEvents(resources ?? {})
      const resumeOpts = events.onStoreError !== undefined
        ? { onStoreError: events.onStoreError }
        : undefined
      const observer = extractRunObserver(resources ?? {})
      // bind observer unconditionally on all ObserverAware resolvedProviders (Invariant 1)
      for (const slot of agentInternals.resolvedProviders.values()) {
        if (slot !== null && typeof slot === 'object' && typeof (slot as Record<string, unknown>)['bindObserver'] === 'function') { // as: duck-typed structural check
          (slot as { bindObserver: (o: Observer) => void }).bindObserver(observer ?? NOOP_OBSERVER) // as: narrowed by duck-type check on line above
        }
      }
      // Build setStepContextSlots from resolvedProviders only (no runtime slots in resume path)
      const setStepContextSlots: Array<{ setStepContext(ctx: StepContext): void }> = []
      for (const slot of agentInternals.resolvedProviders.values()) {
        if (
          slot !== null &&
          typeof slot === 'object' &&
          typeof (slot as Record<string, unknown>)['setStepContext'] === 'function' // as: duck-type check
        ) {
          setStepContextSlots.push(slot as { setStepContext(ctx: StepContext): void }) // as: narrowed by duck-type check on line above
        }
      }
      return makeAgentResumeHandle(response, sessionId, interruptId, resumeOpts, observer ?? undefined, setStepContextSlots.length > 0 ? setStepContextSlots : undefined)
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
