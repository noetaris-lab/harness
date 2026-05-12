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

import { NoInterruptError } from './interrupt-resume.js'

export function createRunHandle(
  sessionId: string,
  execution: Promise<RunOutcome>,
  stopFlag: { stopped: boolean },
  stepRef: { current: string | null },
  resumeFn?: (response: unknown, interruptId: string) => RunHandle,
): RunHandle {
  let settledOutcome: RunOutcome | null = null

  // NOTE: raw .then(onFulfilled, onRejected) is intentional here — NOT a coding-standards
  // violation. async/await requires wrapping in a new async function, which changes control
  // flow and does not populate `settledOutcome` as a side-effect at resolution time.
  // .then() attaches handlers to an already-running Promise, allowing us to capture the
  // fulfilled RunOutcome into the closure variable synchronously within the callback at the
  // moment of resolution. run.resume() reads settledOutcome synchronously, so this is the
  // only correct pattern; replacing it with async/await would break synchronous access.
  const settled = execution.then(
    (outcome: RunOutcome): RunOutcome => {
      settledOutcome = outcome
      stepRef.current = null
      return outcome
    },
    (err: unknown): RunOutcome => {
      stepRef.current = null
      throw err
    },
  )

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

    resume(response: unknown, interruptId: string): RunHandle {
      // backward-compatibility: 4-arg handle (no resumeFn) + unsettled → old stub error
      if (settledOutcome === null && resumeFn === undefined) {
        throw new Error('not implemented — requires F9')
      }
      if (settledOutcome === null) {
        throw new NoInterruptError()
      }
      if (settledOutcome.signal !== '$interrupt') {
        throw new NoInterruptError()
      }
      if (resumeFn === undefined) {
        throw new NoInterruptError()
      }
      return resumeFn(response, interruptId)
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
