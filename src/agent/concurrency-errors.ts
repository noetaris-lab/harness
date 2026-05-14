export class SessionInFlightError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`session "${sessionId}" is already in-flight`)
    this.name = 'SessionInFlightError'
    this.sessionId = sessionId
  }
}

export class SessionPendingInterruptError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`session "${sessionId}" is paused on an interrupt — use agent.resume() instead of agent.run()`)
    this.name = 'SessionPendingInterruptError'
    this.sessionId = sessionId
  }
}

export class StoreLoadError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super('session store failed to load session')
    this.name = 'StoreLoadError'
    this.cause = cause
  }
}
