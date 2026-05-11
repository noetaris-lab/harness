import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { FieldDefinition } from '../harness/state-field.js'

// -----------------------------------------------------------------------
// LoopResult
// -----------------------------------------------------------------------

export interface LoopResult {
  readonly state: Record<string, unknown>
  readonly signal: string | null
  readonly cursor: string | null
  readonly paused: boolean
}

// -----------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------

export class UnknownSignalError extends Error {
  readonly step: string
  readonly signal: string
  constructor(step: string, signal: string) {
    super(`step "${step}" emitted signal "${signal}" with no matching .on() transition`)
    this.name = 'UnknownSignalError'
    this.step = step
    this.signal = signal
  }
}

export class NoNextStepError extends Error {
  readonly step: string
  constructor(step: string) {
    super(
      `step "${step}" has no route, no explicit next, and is the last declared step — execution cannot continue`,
    )
    this.name = 'NoNextStepError'
    this.step = step
  }
}

// -----------------------------------------------------------------------
// Private helpers
// -----------------------------------------------------------------------

function buildImplicitNextMap(graph: LoopDefinition): Map<string, string | null> {
  const map = new Map<string, string | null>()
  for (let i = 0; i < graph.steps.length; i++) {
    const step = graph.steps[i]!
    const next = i + 1 < graph.steps.length ? graph.steps[i + 1]!.name : null
    map.set(step.name, next)
  }
  return map
}

function applyUpdate(
  state: Record<string, unknown>,
  update: Record<string, unknown>,
  schema: Record<string, FieldDefinition<any>> | undefined, // any: FieldDefinition uses invariant T; any is required for heterogeneous schema maps
): void {
  for (const [key, value] of Object.entries(update)) {
    if (key === '$error' || key === '$interrupt') continue
    const reducer = schema?.[key]?.reduce
    if (reducer !== undefined) {
      state[key] = reducer(state[key], value)
    } else {
      state[key] = value
    }
  }
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

export async function runLoop(
  graph: LoopDefinition,
  state: Record<string, unknown>,
  ctx: Record<string, unknown> & { readonly sessionId: string },
  schema: Record<string, FieldDefinition<any>> | undefined, // any: see applyUpdate comment
  shouldStop?: () => boolean,
  onBeforeStep?: (name: string) => void,
): Promise<LoopResult> {
  const implicitNextMap = buildImplicitNextMap(graph)

  // Initialize framework-reserved fields if absent
  if (!('$error' in state)) state.$error = null
  if (!('$interrupt' in state)) state.$interrupt = null

  let cursor = graph.entryStep!

  while (true) {
    if (shouldStop?.()) {
      return { state, signal: null, cursor, paused: true }
    }

    onBeforeStep?.(cursor)

    const step = graph.steps.find(s => s.name === cursor)!

    if (step.run !== undefined) {
      const update = await step.run(
        state as unknown as Parameters<typeof step.run>[0],
        ctx as Parameters<typeof step.run>[1],
      )
      applyUpdate(state, update as Record<string, unknown>, schema)
    }

    if (step.route !== undefined) {
      const signal = step.route(state as unknown as Parameters<typeof step.route>[0])
      const transition = step.transitions.find(t => t.signal === signal)
      if (transition === undefined) {
        throw new UnknownSignalError(cursor, signal)
      }
      if (transition.target.kind === 'end') {
        return { state, signal, cursor: null, paused: false }
      }
      cursor = transition.target.name
    } else {
      const next = step.next ?? implicitNextMap.get(cursor) ?? null
      if (next === null) {
        throw new NoNextStepError(cursor)
      }
      cursor = next
    }
  }
}
