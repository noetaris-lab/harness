import { describe, it, expect } from 'vitest'
import { SessionInFlightError, SessionPendingInterruptError, StoreLoadError } from './concurrency-errors.js'

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

