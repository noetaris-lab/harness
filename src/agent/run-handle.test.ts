import { describe, it, expect } from 'vitest'
import { createRunHandle } from './run-handle.js'
import type { RunOutcome } from './run-handle.js'

describe('createRunHandle', () => {

  describe('factory and identity', () => {

    it('returns a RunHandle synchronously when called with valid arguments', () => {
      // arrange
      const outcome: RunOutcome = { state: {}, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null }

      // act
      const run = createRunHandle('sess-1', execution, stopFlag, stepRef)

      // assert
      expect(run).toBeDefined()
      expect(typeof run.then).toBe('function')
      expect(typeof run.stop).toBe('function')
      expect(typeof run.resume).toBe('function')
      expect(run).not.toBeInstanceOf(Promise)
    })

    it('returns the exact sessionId string passed to createRunHandle', () => {
      // arrange
      const sessionId = 'test-session-abc-123'
      const execution = Promise.resolve({ state: {}, signal: 'done' } as RunOutcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null }

      // act
      const run = createRunHandle(sessionId, execution, stopFlag, stepRef)

      // assert
      expect(run.sessionId).toBe('test-session-abc-123')
    })

  })

  describe('awaitable resolution (PromiseLike)', () => {

    it('resolves with RunOutcome { state, signal "done" } when execution resolves', async () => {
      // arrange
      const state = { messages: ['hello'] }
      const outcome: RunOutcome = { state, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null }
      const run = createRunHandle('sess-1', execution, stopFlag, stepRef)

      // act
      const result = await run

      // assert
      expect(result).toEqual({ state: { messages: ['hello'] }, signal: 'done' })
    })

    it('resolves with RunOutcome { state, signal null } for graceful stop', async () => {
      // arrange
      const state = { count: 0 }
      const outcome: RunOutcome = { state, signal: null }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null }
      const run = createRunHandle('sess-2', execution, stopFlag, stepRef)

      // act
      const result = await run

      // assert
      expect(result).toEqual({ state: { count: 0 }, signal: null })
      expect(result.signal).toBeNull()
    })

    it('resolves with same RunOutcome via Promise.resolve() using PromiseLike protocol', async () => {
      // arrange
      const outcome: RunOutcome = { state: {}, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null }
      const run = createRunHandle('sess-3', execution, stopFlag, stepRef)

      // act
      const result = await Promise.resolve(run)

      // assert
      expect(result).toEqual({ state: {}, signal: 'done' })
    })

    it('delivers same RunOutcome to multiple independent .then() subscribers', async () => {
      // arrange
      const outcome: RunOutcome = { state: { x: 1 }, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null }
      const run = createRunHandle('sess-4', execution, stopFlag, stepRef)

      // act
      const p1 = new Promise<RunOutcome>(resolve => run.then(resolve))
      const p2 = new Promise<RunOutcome>(resolve => run.then(resolve))
      const [r1, r2] = await Promise.all([p1, p2])

      // assert
      expect(r1).toEqual({ state: { x: 1 }, signal: 'done' })
      expect(r2).toEqual({ state: { x: 1 }, signal: 'done' })
      expect(r1).toEqual(r2)
    })

  })

  describe('step tracking (currentStep)', () => {

    it('returns active step name from stepRef when execution is in progress', async () => {
      // arrange
      let resolve!: (v: RunOutcome) => void
      const execution = new Promise<RunOutcome>(r => { resolve = r })
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-5', execution, stopFlag, stepRef)
      stepRef.current = 'think'

      // act
      const step = run.currentStep

      // assert
      expect(step).toBe('think')

      // cleanup
      resolve({ state: {}, signal: 'done' })
    })

    it('returns null from currentStep before execution reaches first step', async () => {
      // arrange
      let resolve!: (v: RunOutcome) => void
      const execution = new Promise<RunOutcome>(r => { resolve = r })
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-6', execution, stopFlag, stepRef)

      // act
      const step = run.currentStep

      // assert
      expect(step).toBeNull()

      // cleanup
      resolve({ state: {}, signal: 'done' })
    })

    it('returns null from currentStep after execution settles', async () => {
      // arrange
      const outcome: RunOutcome = { state: {}, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: 'think' as string | null }
      const run = createRunHandle('sess-7', execution, stopFlag, stepRef)

      // act
      await run

      // assert
      expect(run.currentStep).toBeNull()
      expect(stepRef.current).toBeNull()
    })

  })

  describe('stop behavior', () => {

    it('sets stopFlag.stopped to true when stop() is called', async () => {
      // arrange
      let resolve!: (v: RunOutcome) => void
      const execution = new Promise<RunOutcome>(r => { resolve = r })
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-8', execution, stopFlag, stepRef)

      // act
      run.stop()

      // assert
      expect(stopFlag.stopped).toBe(true)

      // cleanup
      resolve({ state: {}, signal: 'done' })
    })

    it('leaves stopFlag.stopped true and does not throw when stop() is called twice', async () => {
      // arrange
      let resolve!: (v: RunOutcome) => void
      const execution = new Promise<RunOutcome>(r => { resolve = r })
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-9', execution, stopFlag, stepRef)
      run.stop()

      // act
      const callAgain = () => run.stop()

      // assert
      expect(callAgain).not.toThrow()
      expect(stopFlag.stopped).toBe(true)

      // cleanup
      resolve({ state: {}, signal: 'done' })
    })

    it('resolves (does not reject) after stop() is called', async () => {
      // arrange
      const outcome: RunOutcome = { state: {}, signal: null }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-10', execution, stopFlag, stepRef)
      run.stop()

      // act
      const result = await run

      // assert
      expect(result).toEqual({ state: {}, signal: null })
    })

    it('sets stopFlag.stopped to true and leaves outcome unchanged when stop() is called after settle', async () => {
      // arrange
      const outcome: RunOutcome = { state: { done: true }, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-11', execution, stopFlag, stepRef)
      const result = await run

      // act
      run.stop()

      // assert
      expect(stopFlag.stopped).toBe(true)
      expect(result).toEqual({ state: { done: true }, signal: 'done' })
    })

  })

  describe('resume stub', () => {

    it('throws an error with message containing "not implemented" when resume() is called', () => {
      // arrange
      const outcome: RunOutcome = { state: {}, signal: 'done' }
      const execution = Promise.resolve(outcome)
      const stopFlag = { stopped: false }
      const stepRef = { current: null as string | null }
      const run = createRunHandle('sess-12', execution, stopFlag, stepRef)

      // act
      const callResume = () => run.resume({}, 'interrupt-1')

      // assert
      expect(callResume).toThrow(Error)
      expect(callResume).toThrow(/not implemented/i)
    })

  })

})
