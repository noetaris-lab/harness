/**
 * Identifies the agent and session for run-level observer callbacks.
 */
export interface RunContext {
  readonly agentId: string
  readonly sessionId: string
}

/**
 * Identifies the agent, session, and current step for step-level observer callbacks.
 */
export interface StepContext {
  readonly agentId: string
  readonly sessionId: string
  readonly stepName: string
}

/**
 * Observability hook interface.  All methods are optional — implement only
 * the hooks you need.
 *
 * Pass an `Observer` implementation in `agent.run()` resources under the key
 * `'observer'`, or bind it to an {@link ObserverAware} slot before running.
 *
 * LLM adapters emit `'llm.response'` events via `onEvent` carrying an
 * `LLMUsageEvent` payload for token tracking.
 *
 * @example
 * ```ts
 * const obs: Observer = {
 *   onRunStart: (ctx) => console.log('run started', ctx.sessionId),
 *   onEvent: (ctx, type, payload) => metrics.record(type, payload),
 * }
 * agent.run({}, { llm, observer: obs })
 * ```
 */
export interface Observer {
  /** Called once when a run begins, before the first step executes. */
  onRunStart?:  (ctx: RunContext) => void
  /** Called once when a run settles (completed or stopped). */
  onRunEnd?:    (ctx: RunContext,  event: { signal: string; durationMs: number }) => void
  /** Called immediately before each step's `run` function is invoked. */
  onStepStart?: (ctx: StepContext) => void
  /** Called after a step completes successfully. */
  onStepEnd?:   (ctx: StepContext, event: { durationMs: number }) => void
  /** Called when a step's `run` function throws. */
  onStepError?: (ctx: StepContext, event: { error: unknown; durationMs: number }) => void
  /** Called when a step issues a `ctx.interrupt()`. */
  onInterrupt?: (ctx: StepContext, event: { prompt: unknown; interruptId: string }) => void
  /**
   * Called for arbitrary named events emitted by step code via `ctx.emit()` or
   * by LLM adapters (e.g. `'llm.response'`).
   */
  onEvent?:     (ctx: StepContext, type: string, payload: unknown) => void
}

/**
 * Implemented by resources (e.g. LLM adapters) that accept an {@link Observer}
 * at run time.  The harness calls `bindObserver` on every slot value that
 * implements this interface before the first step runs.
 */
export interface ObserverAware {
  /**
   * Receive the run's observer.  The harness calls this once per `agent.run()`
   * invocation before execution begins.
   */
  bindObserver(observer: Observer): void
}

/**
 * Combine multiple {@link Observer} instances into one.  Each hook on the
 * composite forwards to all constituent observers in order.
 *
 * @example
 * ```ts
 * const observer = composeObservers(otelObserver, metricsObserver)
 * ```
 */
export function composeObservers(...observers: Observer[]): Observer {
  return {
    onRunStart: (ctx) => {
      for (const o of observers) o.onRunStart?.(ctx)
    },
    onRunEnd: (ctx, event) => {
      for (const o of observers) o.onRunEnd?.(ctx, event)
    },
    onStepStart: (ctx) => {
      for (const o of observers) o.onStepStart?.(ctx)
    },
    onStepEnd: (ctx, event) => {
      for (const o of observers) o.onStepEnd?.(ctx, event)
    },
    onStepError: (ctx, event) => {
      for (const o of observers) o.onStepError?.(ctx, event)
    },
    onInterrupt: (ctx, event) => {
      for (const o of observers) o.onInterrupt?.(ctx, event)
    },
    onEvent: (ctx, type, payload) => {
      for (const o of observers) o.onEvent?.(ctx, type, payload)
    },
  }
}
