// -----------------------------------------------------------------------
// InterruptPause — internal control-flow signal between ctx-interrupt and loop-executor
// -----------------------------------------------------------------------

export class InterruptPause extends Error {
  readonly interruptId: string
  readonly prompt: unknown

  constructor(interruptId: string, prompt: unknown) {
    super(`interrupt requested for id "${interruptId}"`)
    this.name = 'InterruptPause'
    this.interruptId = interruptId
    this.prompt = prompt
  }
}

// -----------------------------------------------------------------------
// isInterruptPause — type guard used by runLoop
// -----------------------------------------------------------------------

export function isInterruptPause(error: unknown): error is InterruptPause {
  return error instanceof InterruptPause
}

// -----------------------------------------------------------------------
// createInterruptFn — factory for ctx.interrupt()
// -----------------------------------------------------------------------

export function createInterruptFn(
  state: Record<string, unknown>,
  callCountRef: { current: number },
): (prompt: unknown, id?: string) => Promise<unknown> {
  return async (prompt: unknown, id?: string): Promise<unknown> => {
    const isAutoId = id === undefined
    const effectiveId = isAutoId ? `$auto:${callCountRef.current}` : id

    // only auto-id calls increment the counter
    if (isAutoId) {
      callCountRef.current++
    }

    const responses = state.$interruptResponses as Record<string, unknown>

    if (effectiveId in responses) {
      return responses[effectiveId]
    }

    state.$interrupt = { interruptId: effectiveId, prompt }
    throw new InterruptPause(effectiveId, prompt)
  }
}
