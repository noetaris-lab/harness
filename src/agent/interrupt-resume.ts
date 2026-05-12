import type { SessionStore, StoredSession } from './session-store.js'

// -----------------------------------------------------------------------
// NoInterruptError
// -----------------------------------------------------------------------

export class NoInterruptError extends Error {
  constructor() {
    super(
      'resume() called but the session is not paused on a matching interrupt — ' +
      'verify the session exists, its phase is "paused", and interruptId matches',
    )
    this.name = 'NoInterruptError'
  }
}

// -----------------------------------------------------------------------
// injectInterruptResponse
// -----------------------------------------------------------------------

export async function injectInterruptResponse(
  store: SessionStore,
  sessionId: string,
  interruptId: string,
  response: unknown,
): Promise<void> {
  const loaded = await store.load(sessionId)

  if (loaded === null) throw new NoInterruptError()
  if (loaded.phase !== 'paused') throw new NoInterruptError()

  const interrupt = loaded.state.$interrupt as { interruptId: string } | null // as: $interrupt is a framework-reserved field with known shape
  if (interrupt === null) throw new NoInterruptError()
  if (interrupt.interruptId !== interruptId) throw new NoInterruptError()

  const existingResponses = (loaded.state.$interruptResponses as Record<string, unknown>) ?? {}
  const newState: Record<string, unknown> = {
    ...loaded.state,
    $interrupt: null,
    $interruptResponses: { ...existingResponses, [interruptId]: response },
  }

  const updated: StoredSession = {
    phase: 'paused',
    state: newState,
    ...(loaded.step !== undefined ? { step: loaded.step } : {}),
    ...(loaded.signal !== undefined ? { signal: loaded.signal } : {}),
  }

  await store.save(sessionId, updated)
}
