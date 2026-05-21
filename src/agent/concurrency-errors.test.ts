import { describe, it, expect } from 'vitest'
import {
  SessionInFlightError,
  SessionPendingInterruptError,
  StoreLoadError,
  SessionBusyError,
  LeaseExpiredError,
} from './concurrency-errors.js'

describe('SessionInFlightError', () => {

  it('sets name, message, and sessionId correctly when constructed', () => {
    // arrange / act
    const error = new SessionInFlightError('abc-123')

    // assert
    expect(error.name).toBe('SessionInFlightError')
    expect(error.message).toBe('session "abc-123" is already in-flight')
    expect(error.sessionId).toBe('abc-123')
  })

})

describe('SessionPendingInterruptError', () => {

  it('sets name, sessionId, and message containing sessionId when constructed', () => {
    // arrange / act
    const error = new SessionPendingInterruptError('def-456')

    // assert
    expect(error.name).toBe('SessionPendingInterruptError')
    expect(error.message).toContain('def-456')
    expect(error.message).toContain('agent.resume()')
    expect(error.sessionId).toBe('def-456')
  })

})

describe('StoreLoadError', () => {

  it('preserves Error cause by reference and sets name and message when constructed with an Error', () => {
    // arrange
    const originalError = new Error('db timeout')

    // act
    const error = new StoreLoadError(originalError)

    // assert
    expect(error.name).toBe('StoreLoadError')
    expect(error.message).toBe('session store failed to load session')
    expect(error.cause).toBe(originalError)
  })

  it('preserves non-Error cause unchanged when constructed with a string', () => {
    // arrange / act
    const error = new StoreLoadError('connection refused')

    // assert
    expect(error.cause).toBe('connection refused')
  })

})

// -----------------------------------------------------------------------
// Group 1: SessionBusyError construction
// -----------------------------------------------------------------------

describe('SessionBusyError', () => {

  it('sets sessionId, name, message, and retryAfter when constructed with retryAfter', () => {
    // arrange / act
    const error = new SessionBusyError('sess-42', 1700000000000)

    // assert
    expect(error.sessionId).toBe('sess-42')
    expect(error.retryAfter).toBe(1700000000000)
    expect(error.name).toBe('SessionBusyError')
    expect(error.message).toContain('sess-42')
  })

  it('omits retryAfter property entirely when constructed without retryAfter', () => {
    // arrange / act
    const error = new SessionBusyError('sess-99')

    // assert
    expect(error.retryAfter).toBeUndefined()
    expect('retryAfter' in error).toBe(false)
    expect(error.sessionId).toBe('sess-99')
  })

})

// -----------------------------------------------------------------------
// Group 2: LeaseExpiredError construction
// -----------------------------------------------------------------------

describe('LeaseExpiredError', () => {

  it('sets sessionId, name, and message containing sessionId and "expired" when constructed', () => {
    // arrange / act
    const error = new LeaseExpiredError('abc')

    // assert
    expect(error.sessionId).toBe('abc')
    expect(error.name).toBe('LeaseExpiredError')
    expect(error.message).toContain('abc')
    expect(error.message).toContain('expired')
  })

})

