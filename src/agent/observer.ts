export interface RunContext {
  readonly agentId: string
  readonly sessionId: string
}

export interface StepContext {
  readonly agentId: string
  readonly sessionId: string
  readonly stepName: string
}

export interface Observer {
  onRunStart?:  (ctx: RunContext) => void
  onRunEnd?:    (ctx: RunContext,  event: { signal: string; durationMs: number }) => void
  onStepStart?: (ctx: StepContext) => void
  onStepEnd?:   (ctx: StepContext, event: { durationMs: number }) => void
  onStepError?: (ctx: StepContext, event: { error: unknown; durationMs: number }) => void
  onInterrupt?: (ctx: StepContext, event: { prompt: unknown; interruptId: string }) => void
  onEvent?:     (ctx: StepContext, type: string, payload: unknown) => void
}

export interface ObserverAware {
  bindObserver(observer: Observer): void
}

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
