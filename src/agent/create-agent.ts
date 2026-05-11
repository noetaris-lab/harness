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
import { resolveSessionStore, querySessionPhase } from './session-lifecycle.js'

// -----------------------------------------------------------------------
// Agent — the minimal public object returned by createAgent
// -----------------------------------------------------------------------

export interface Agent {
  /**
   * Start a new run or resume an existing session.
   * Stub implementation in F5 throws. Real implementation in F6/F7/F8.
   */
  run(initialState: Record<string, unknown>, resources: Record<string, unknown>): never

  /**
   * Cross-process entry point for responding to a pending interrupt.
   * Stub implementation in F5 throws. Real implementation in F8/F9.
   */
  resume(response: unknown, sessionId: string, interruptId: string): never

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

  for (const entry of internals.providers) {
    if (entry.kind === 'store') {
      storeEntries.push(entry)
    } else if (entry.kind === 'provide') {
      if (isRequiredMarker(entry.value)) {
        // Replace required() marker with the slot value
        resolvedProviders.set(entry.key, (slots as Record<string, unknown>)[entry.key]) // as: Req extends keyof Ctx erases to plain index at runtime
      } else if (!isRuntimeMarker(entry.value)) {
        // Concrete value: include as-is
        resolvedProviders.set(entry.key, entry.value)
      }
      // runtime() markers are not included in resolvedProviders
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
  }

  // Create and return Agent with attached internals
  const agent: AgentWithInternals = {
    run: () => {
      throw new Error('not implemented — requires F6/F7/F8')
    },
    resume: () => {
      throw new Error('not implemented — requires F6/F7/F8')
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
