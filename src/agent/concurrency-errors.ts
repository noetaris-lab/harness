/**
 * Thrown by {@link Agent.run} or {@link Agent.resume} when the given session
 * is already executing a run in the same process.
 *
 * Wait for the in-flight {@link RunHandle} to settle before starting a new run.
 */
export class SessionInFlightError extends Error {
  /** The session that was already in-flight. */
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`session "${sessionId}" is already in-flight`)
    this.name = 'SessionInFlightError'
    this.sessionId = sessionId
  }
}

/**
 * Thrown by {@link Agent.run} when the session is paused on an unanswered
 * interrupt.  Call {@link Agent.resume} (or `handle.resume()`) instead.
 */
export class SessionPendingInterruptError extends Error {
  /** The session that is awaiting an interrupt response. */
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`session "${sessionId}" is paused on an interrupt — use agent.resume() instead of agent.run()`)
    this.name = 'SessionPendingInterruptError'
    this.sessionId = sessionId
  }
}

/**
 * Thrown by the harness when the session store's `load()` call rejects.
 * The original error is available on the `cause` property.
 */
export class StoreLoadError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super('session store failed to load session')
    this.name = 'StoreLoadError'
    this.cause = cause
  }
}
