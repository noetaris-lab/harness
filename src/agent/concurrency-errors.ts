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

/**
 * Thrown by {@link Agent.run} when `store.claim()` returns `null` —
 * another instance already holds the session claim.
 *
 * The caller may inspect `retryAfter` to implement a `429 Retry-After`
 * response or a retry backoff. How to respond is not the framework's concern.
 */
export class SessionBusyError extends Error {
  /** The session that is currently claimed by another instance. */
  readonly sessionId: string
  /**
   * Hint: earliest time (milliseconds since epoch) when a retry may succeed.
   * Derived from the original claim's `expiresAt`. Present when the store
   * includes expiry information in a busy response; absent otherwise.
   */
  // declare: avoids useDefineForClassFields emitting an undefined own property initializer;
  // the field is only written when retryAfter is provided (exactOptionalPropertyTypes guard)
  declare readonly retryAfter?: number

  constructor(sessionId: string, retryAfter?: number) {
    super(`session "${sessionId}" is currently claimed by another instance`)
    this.name = 'SessionBusyError'
    this.sessionId = sessionId
    // conditional assignment: avoids producing retryAfter: undefined as an own property
    // which exactOptionalPropertyTypes forbids at call sites
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

/**
 * Thrown by the framework at a step boundary when the active lease has expired
 * without renewal.
 *
 * The run stops without saving state — the session remains at its last
 * checkpoint, allowing another instance to claim and resume it.
 */
export class LeaseExpiredError extends Error {
  /** The session whose lease expired. */
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`lease for session "${sessionId}" has expired — run stopped without saving`)
    this.name = 'LeaseExpiredError'
    this.sessionId = sessionId
  }
}

