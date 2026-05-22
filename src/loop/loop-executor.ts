import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { FieldDefinition } from '../harness/state-field.js'
import type { Observer, RunContext, StepContext } from '../agent/observer.js'
import { createInterruptFn, isInterruptPause } from '../agent/ctx-interrupt.js'
import { createEmitFn } from '../agent/ctx-emit.js'

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
    if (key === '$error' || key === '$interrupt' || key === '$interruptResponses') continue
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

export interface LoopCallbacks {
  onBeforeStep?: (name: string, state: Record<string, unknown>) => void
  onAfterStep?: (name: string, state: Record<string, unknown>) => void
  onError?: (error: unknown, stepName: string) => void
  onComplete?: (state: Record<string, unknown>, signal: string) => void
  onInterrupt?: (prompt: unknown, interruptId: string) => void
  /**
   * Listeners for user-emitted events (ctx.emit). Keyed by event name.
   * A missing key means ctx.emit(name) is a no-op for that name.
   */
  listeners?: Record<string, (payload: unknown) => void>
  /** Observer for structured telemetry. All lifecycle methods are optional. F16b. */
  observer?: Observer
  /**
   * The UUID for this specific invocation. Included in RunContext for observer
   * methods. Absent when no observer is active (observer is still consistent).
   */
  runId?: string
  /**
   * Optional parent run UUID for cross-process trace correlation.
   * Included in RunContext when provided.
   */
  parentRunId?: string
}

export async function runLoop(
  graph: LoopDefinition,
  state: Record<string, unknown>,
  ctx: Record<string, unknown> & { readonly agentId: string; readonly sessionId: string },
  schema: Record<string, FieldDefinition<any>> | undefined, // any: see applyUpdate comment
  shouldStop?: () => boolean,
  startCursor?: string,
  callbacks?: LoopCallbacks,
): Promise<LoopResult> {
  const { onBeforeStep, onAfterStep, onError, onComplete, onInterrupt } = callbacks ?? {}
  const obs = callbacks?.observer
  const implicitNextMap = buildImplicitNextMap(graph)

  // Initialize framework-reserved fields if absent
  if (!('$error' in state)) state.$error = null
  if (!('$interrupt' in state)) state.$interrupt = null
  if (!('$interruptResponses' in state)) state.$interruptResponses = {}

  const runStart = Date.now()
  const runCtx: RunContext = {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    runId: typeof callbacks?.runId === 'string' ? callbacks.runId : '',
    ...(typeof callbacks?.parentRunId === 'string' ? { parentRunId: callbacks.parentRunId } : {}),
    ...(typeof ctx.instanceId === 'string' ? { instanceId: ctx.instanceId } : {}),
  }
  obs?.onRunStart?.(runCtx)

  // callCountRef is shared between createInterruptFn and the per-step reset below
  const callCountRef = { current: 0 }
  const stepCtxRef: { current: StepContext | null } = { current: null }
  // mutate ctx in-place so step.run receives the same object reference (invariant for callers)
  ;(ctx as Record<string, unknown>)['interrupt'] = createInterruptFn(state, callCountRef) // as: Record<string, unknown> allows adding framework-injected fields to ctx
  ;(ctx as Record<string, unknown>)['emit'] = createEmitFn(callbacks?.listeners ?? {}, obs, stepCtxRef) // as: see interrupt line comment

  let cursor = startCursor ?? graph.entryStep!

  while (true) {
    if (shouldStop?.()) {
      obs?.onRunEnd?.(runCtx, { signal: '$stopped', durationMs: Date.now() - runStart })
      return { state, signal: null, cursor, paused: true }
    }

    // pass a shallow snapshot so onBeforeStep observers see pre-run values even after state is mutated
    onBeforeStep?.(cursor, { ...state })

    const step = graph.steps.find(s => s.name === cursor)!

    // reset per-step counter before run (even for decision nodes, per design)
    callCountRef.current = 0

    const stepCtx: StepContext = { agentId: ctx.agentId, sessionId: ctx.sessionId, stepName: cursor }
    stepCtxRef.current = stepCtx
    const stepStart = Date.now()
    obs?.onStepStart?.(stepCtx)

    let runSucceeded = false

    if (step.run !== undefined) {
      // capture whether responses exist before the run; only clear interrupt state if they did
      const hadResponses = Object.keys(state.$interruptResponses as Record<string, unknown>).length > 0
      try {
        const update = await step.run(
          state as unknown as Parameters<typeof step.run>[0],
          ctx as Parameters<typeof step.run>[1],
        )
        applyUpdate(state, update as Record<string, unknown>, schema)
        // clear interrupt state only after a step that had stored responses to replay
        if (hadResponses) {
          state.$interrupt = null
          state.$interruptResponses = {}
        }
        runSucceeded = true
      } catch (e) {
        if (isInterruptPause(e)) {
          // InterruptPause was caught: $interrupt already written by createInterruptFn
          onInterrupt?.(e.prompt, e.interruptId)
          obs?.onInterrupt?.(stepCtx, { prompt: e.prompt, interruptId: e.interruptId })
          obs?.onRunEnd?.(runCtx, { signal: '$interrupt', durationMs: Date.now() - runStart })
          return { state, signal: '$interrupt', cursor, paused: true }
        }
        // domain error: normalize to Error and set $error; do not rethrow
        state.$error = e instanceof Error ? e : new Error(String(e))
        onError?.(state.$error, cursor)
        obs?.onStepError?.(stepCtx, { error: state.$error, durationMs: Date.now() - stepStart })
      }
    }

    if (runSucceeded) {
      // clear $error after a successful run, before calling route
      state.$error = null
      onAfterStep?.(cursor, state)
      obs?.onStepEnd?.(stepCtx, { durationMs: Date.now() - stepStart })
    }

    // route is called when: route exists AND (run succeeded, step has no run, OR step opted in
    // to error routing via optin: '$error' in the step config)
    const callRoute =
      step.route !== undefined &&
      (runSucceeded || step.run === undefined || step.errorAware)

    if (callRoute) {
      // callRoute implies step.route !== undefined; non-null assertion is sound here
      const routeFn = step.route!
      let signal: string
      try {
        signal = routeFn(state as unknown as Parameters<typeof routeFn>[0])
      } catch (e) {
        // route itself threw — treat as terminal error; state update from run already stands
        state.$error = e instanceof Error ? e : new Error(String(e))
        obs?.onRunEnd?.(runCtx, { signal: '$error', durationMs: Date.now() - runStart })
        return { state, signal: '$error', cursor, paused: true }
      }
      const transition = step.transitions.find(t => t.signal === signal)
      if (transition === undefined) {
        throw new UnknownSignalError(cursor, signal)
      }
      if (transition.target.kind === 'end') {
        onComplete?.(state, signal)
        obs?.onRunEnd?.(runCtx, { signal, durationMs: Date.now() - runStart })
        return { state, signal, cursor: null, paused: false }
      }
      cursor = transition.target.name
    } else if (step.run !== undefined && !runSucceeded) {
      // run threw, route bypassed (not error-aware) or no route: apply l.onError() fallback or pause
      if (graph.onError !== undefined) {
        cursor = graph.onError
      } else {
        obs?.onRunEnd?.(runCtx, { signal: '$error', durationMs: Date.now() - runStart })
        return { state, signal: '$error', cursor, paused: true }
      }
    } else {
      const next = step.next ?? implicitNextMap.get(cursor) ?? null
      if (next === null) {
        throw new NoNextStepError(cursor)
      }
      cursor = next
    }
  }
}
