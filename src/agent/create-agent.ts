import {
  getInternals,
  type Harness,
  type HarnessInternals,
  type ProviderEntry,
} from '../harness/harness-builder.js'
import { isRequiredMarker, isRuntimeMarker } from '../harness/ctx-markers.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { FieldDefinition } from '../harness/state-field.js'
import type { SessionPhase } from './session-store.js'
import { resolveSessionStore, runWithSession, querySessionPhase, type SessionRunOptions } from './session-lifecycle.js'
import { runLoop } from '../loop/loop-executor.js'
import { createRunHandle, type RunHandle, type RunOutcome } from './run-handle.js'
import { NoInterruptError, injectInterruptResponse } from './interrupt-resume.js'
import { SessionInFlightError, SessionPendingInterruptError } from './concurrency-errors.js'
import { randomUUID } from 'node:crypto'

// -----------------------------------------------------------------------
// Agent — the minimal public object returned by createAgent
// -----------------------------------------------------------------------

export interface Agent {
  /**
   * Start a new run. Returns a RunHandle synchronously before execution begins.
   */
  run(initialState: Record<string, unknown>, resources: Record<string, unknown>): RunHandle

  /**
   * Cross-process entry point for responding to a pending interrupt.
   * Returns a RunHandle synchronously; the execution promise performs the resume.
   */
  resume(response: unknown, sessionId: string, interruptId: string): RunHandle

  /**
   * Query the session store for the current phase of a session.
   */
  status(sessionId: string): Promise<SessionPhase>
}

// -----------------------------------------------------------------------
// AgentInternals — the resolved internal state
// -----------------------------------------------------------------------

export interface AgentInternals {
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

export class MissingLoopError extends Error {
  constructor() {
    super('harness has no loop — call h.loop() before createAgent()')
    this.name = 'MissingLoopError'
  }
}

export class MissingSlotError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`required slot "${key}" was not provided in createAgent slots`)
    this.name = 'MissingSlotError'
    this.key = key
  }
}

export class RuntimeSlotInAgentError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`slot "${key}" is a runtime() slot — provide it in agent.run(), not createAgent()`)
    this.name = 'RuntimeSlotInAgentError'
    this.key = key
  }
}

export class UnknownSlotError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`slot "${key}" is not declared in the harness — remove it or add h.provide("${key}", required())`)
    this.name = 'UnknownSlotError'
    this.key = key
  }
}

export class AgentInternalsError extends Error {
  constructor() {
    super('value was not produced by createAgent — cannot read AgentInternals')
    this.name = 'AgentInternalsError'
  }
}

export class MissingRuntimeSlotError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`runtime slot "${key}" was not provided in agent.run() resources`)
    this.name = 'MissingRuntimeSlotError'
    this.key = key
  }
}

export class RequiredSlotInRunError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`slot "${key}" is a required() slot — provide it in createAgent(), not agent.run()`)
    this.name = 'RequiredSlotInRunError'
    this.key = key
  }
}

export class UnknownRunSlotError extends Error {
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

export function createAgent<Ctx, State, Req extends keyof Ctx, Run extends keyof Ctx>(
  h: Harness<Ctx, State, Req, Run>,
  slots: Pick<Ctx, Req>,
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
    resolvedProviders,
    storeEntries,
    loopDef: internals.loopDef, // Guaranteed to be non-undefined by validation 1
    stateSchema: internals.stateSchema,
    runtimeKeys,
    requiredKeys,
  }

  // Reserved keys are skipped during agent.run() resource validation
  const reservedRunKeys = new Set(['sessionId', 'signal', 'events'])

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
  ): RunHandle => {
    const flag = { stopped: false }
    const ref: { current: string | null } = { current: null }

    const exec = (async (): Promise<RunOutcome> => {
      await Promise.resolve()
      try {
        if (capturedStore === undefined) throw new NoInterruptError()
        await injectInterruptResponse(capturedStore, sId, iId, resp)
        const agentCtx: Record<string, unknown> & { readonly sessionId: string } = {
          ...Object.fromEntries(agentInternals.resolvedProviders),
          sessionId: sId,
        }
        const r = await runWithSession(
          capturedStore,
          sId,
          agentInternals.loopDef,
          {},
          agentInternals.stateSchema,
          agentCtx,
          {
            shouldStop: () => flag.stopped,
            onBeforeStep: (n: string) => { ref.current = n },
          },
        )
        if (r.signal === '$interrupt') interruptPendingSessions.add(sId)
        return { state: r.state, signal: r.signal }
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
    return createRunHandle(sId, exec, flag, ref, resumeFn)
  }

  // Create and return Agent with attached internals
  const agent: AgentWithInternals = {
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
        runtimeSlots[key] = resources[key]
      }
      const ctx: Record<string, unknown> & { readonly sessionId: string } = {
        ...Object.fromEntries(agentInternals.resolvedProviders),
        ...runtimeSlots,
        sessionId,
      }

      // Extract event callbacks from resources (reserved key)
      const events = (resources['events'] ?? {}) as Record<string, ((...args: unknown[]) => void) | undefined>

      const options: SessionRunOptions = {
        shouldStop: () => stopFlag.stopped,
        onBeforeStep: (name: string) => { stepRef.current = name },
        onStoreError: (error, phase) => { events['onStoreError']?.(error, phase) },
      }

      // lastResult captures the LoopResult for same-process in-memory resume chaining
      let lastResult: { state: Record<string, unknown>; cursor: string | null } | null = null

      // Launch execution asynchronously — agent.run() returns before any async work begins
      const execution = (async (): Promise<RunOutcome> => {
        // Yield so agent.run() can return the RunHandle before any loop iteration starts
        await Promise.resolve()
        try {
          const r = await runWithSession(
            capturedStore,
            sessionId,
            agentInternals.loopDef,
            initialState,
            agentInternals.stateSchema,
            ctx,
            options,
          )
          if (r.signal === '$interrupt') interruptPendingSessions.add(sessionId)
          lastResult = { state: r.state, cursor: r.cursor }
          return { state: r.state, signal: r.signal }
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

          const resumeExecution = (async (): Promise<RunOutcome> => {
            await Promise.resolve()
            try {
              if (capturedStore !== undefined) {
                // Cross-process path: inject response into store, reload, and re-run
                await injectInterruptResponse(capturedStore, sessionId, interruptId, response)
                const r = await runWithSession(
                  capturedStore,
                  sessionId,
                  agentInternals.loopDef,
                  {},
                  agentInternals.stateSchema,
                  ctx,
                  {
                    shouldStop: () => resumeStopFlag.stopped,
                    onBeforeStep: (n: string) => { resumeStepRef.current = n },
                    onStoreError: (error, phase) => { events['onStoreError']?.(error, phase) },
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
                (n: string) => { resumeStepRef.current = n },
                cursor,
              )
              if (r.signal === '$interrupt') interruptPendingSessions.add(sessionId)
              lastResult = { state: r.state, cursor: r.cursor }
              return { state: r.state, signal: r.signal }
            } finally {
              inFlightSessions.delete(sessionId)
            }
          })()

          return createRunHandle(sessionId, resumeExecution, resumeStopFlag, resumeStepRef, buildResumeFn())
        }
      }

      return createRunHandle(sessionId, execution, stopFlag, stepRef, buildResumeFn())
    },

    resume: (response: unknown, sessionId: string, interruptId: string): RunHandle => {
      if (inFlightSessions.has(sessionId)) throw new SessionInFlightError(sessionId)
      interruptPendingSessions.delete(sessionId)
      inFlightSessions.add(sessionId)
      return makeAgentResumeHandle(response, sessionId, interruptId)
    },

    status: (sessionId: string) => querySessionPhase(capturedStore, sessionId),
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
