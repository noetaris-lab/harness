export interface RunOutcome {
  readonly state: Record<string, unknown>
  readonly signal: string | null
}

export interface RunHandle extends PromiseLike<RunOutcome> {
  /** Cancel the in-flight run at the next safe point between steps. Idempotent. */
  stop(): void

  /**
   * Provide a response to a pending ctx.interrupt() call.
   * Returns a new RunHandle for the resumed execution.
   * Stub in F8 — implemented in F9.
   */
  resume(response: unknown, interruptId: string): RunHandle

  /** The session identity for this run. */
  readonly sessionId: string

  /**
   * The name of the step currently executing in this process.
   * null before the first step runs, after execution settles, and always when inspected cross-process.
   */
  readonly currentStep: string | null
}

export function createRunHandle(
  sessionId: string,
  execution: Promise<RunOutcome>,
  stopFlag: { stopped: boolean },
  stepRef: { current: string | null },
): RunHandle {
  // clear stepRef on settle regardless of how execution resolves
  const settled = execution.finally(() => {
    stepRef.current = null
  })

  const handle: RunHandle = {
    then<TResult1 = RunOutcome, TResult2 = never>(
      onfulfilled?: ((value: RunOutcome) => TResult1 | PromiseLike<TResult1>) | null | undefined,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
    ): Promise<TResult1 | TResult2> {
      return settled.then(onfulfilled, onrejected)
    },

    stop(): void {
      stopFlag.stopped = true
    },

    resume(_response: unknown, _interruptId: string): RunHandle {
      throw new Error('not implemented — requires F9')
    },

    get sessionId(): string {
      return sessionId
    },

    get currentStep(): string | null {
      return stepRef.current
    },
  }

  return handle
}
