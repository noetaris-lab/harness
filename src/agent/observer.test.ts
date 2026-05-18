import { describe, it, expect, vi } from 'vitest'
import { composeObservers, type RunContext, type StepContext } from './observer.js'

describe('composeObservers', () => {

  describe('single-observer forwarding', () => {

    it('forwards onRunStart call to single observer with exact context', () => {
      // arrange
      const obs = { onRunStart: vi.fn() }
      const runCtx: RunContext = { agentId: 'agent-1', sessionId: 'sess-1' }

      // act
      const composed = composeObservers(obs)
      composed.onRunStart!(runCtx)

      // assert
      expect(obs.onRunStart).toHaveBeenCalledOnce()
      expect(obs.onRunStart).toHaveBeenCalledWith(runCtx)
    })

    it('forwards onEvent call with context, type, and payload by reference', () => {
      // arrange
      const obs = { onEvent: vi.fn() }
      const stepCtx: StepContext = { agentId: 'agent-1', sessionId: 'sess-1', stepName: 'step-a' }
      const payload = { detail: 42 }

      // act
      const composed = composeObservers(obs)
      composed.onEvent!(stepCtx, 'llm.response', payload)

      // assert
      expect(obs.onEvent).toHaveBeenCalledOnce()
      expect(obs.onEvent).toHaveBeenCalledWith(stepCtx, 'llm.response', payload)
    })

    it('forwards onRunEnd call with context and event object by reference', () => {
      // arrange
      const obs = { onRunEnd: vi.fn() }
      const runCtx: RunContext = { agentId: 'agent-1', sessionId: 'sess-1' }
      const event = { signal: 'done', durationMs: 150 }

      // act
      const composed = composeObservers(obs)
      composed.onRunEnd!(runCtx, event)

      // assert
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(runCtx, event)
    })

  })

  describe('partial observer — missing method silently skipped', () => {

    it("calls B's onStepEnd when A does not implement it", () => {
      // arrange
      const obsA = {}
      const obsB = { onStepEnd: vi.fn() }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }
      const event = { durationMs: 20 }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onStepEnd!(stepCtx, event)

      // assert
      expect(obsB.onStepEnd).toHaveBeenCalledOnce()
      expect(obsB.onStepEnd).toHaveBeenCalledWith(stepCtx, event)
    })

    it("calls A's onStepStart when B does not implement it", () => {
      // arrange
      const obsA = { onStepStart: vi.fn() }
      const obsB = {}
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onStepStart!(stepCtx)

      // assert
      expect(obsA.onStepStart).toHaveBeenCalledOnce()
      expect(obsA.onStepStart).toHaveBeenCalledWith(stepCtx)
    })

    it("calls B's onStepError when A does not implement it", () => {
      // arrange
      const obsA = {}
      const obsB = { onStepError: vi.fn() }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }
      const event = { error: new Error('boom'), durationMs: 5 }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onStepError!(stepCtx, event)

      // assert
      expect(obsB.onStepError).toHaveBeenCalledOnce()
      expect(obsB.onStepError).toHaveBeenCalledWith(stepCtx, event)
    })

    it("calls B's onInterrupt when A does not implement it", () => {
      // arrange
      const obsA = {}
      const obsB = { onInterrupt: vi.fn() }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }
      const event = { prompt: { question: 'continue?' }, interruptId: 'int-1' }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onInterrupt!(stepCtx, event)

      // assert
      expect(obsB.onInterrupt).toHaveBeenCalledOnce()
      expect(obsB.onInterrupt).toHaveBeenCalledWith(stepCtx, event)
    })

  })

  describe('fan-out ordering', () => {

    it('calls A then B on onStepStart when both implement it', () => {
      // arrange
      const callOrder: string[] = []
      const obsA = { onStepStart: vi.fn(() => callOrder.push('A')) }
      const obsB = { onStepStart: vi.fn(() => callOrder.push('B')) }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onStepStart!(stepCtx)

      // assert
      expect(callOrder).toEqual(['A', 'B'])
      expect(obsA.onStepStart).toHaveBeenCalledWith(stepCtx)
      expect(obsB.onStepStart).toHaveBeenCalledWith(stepCtx)
    })

    it('calls a then b then c on onRunEnd for three-observer composition', () => {
      // arrange
      const callOrder: string[] = []
      const obsA = { onRunEnd: vi.fn(() => callOrder.push('A')) }
      const obsB = { onRunEnd: vi.fn(() => callOrder.push('B')) }
      const obsC = { onRunEnd: vi.fn(() => callOrder.push('C')) }
      const runCtx: RunContext = { agentId: 'a', sessionId: 's' }
      const event = { signal: 'done', durationMs: 300 }

      // act
      const composed = composeObservers(obsA, obsB, obsC)
      composed.onRunEnd!(runCtx, event)

      // assert
      expect(callOrder).toEqual(['A', 'B', 'C'])
      expect(obsA.onRunEnd).toHaveBeenCalledWith(runCtx, event)
      expect(obsB.onRunEnd).toHaveBeenCalledWith(runCtx, event)
      expect(obsC.onRunEnd).toHaveBeenCalledWith(runCtx, event)
    })

    it('calls A then B on onStepError, forwarding same references', () => {
      // arrange
      const callOrder: string[] = []
      const obsA = { onStepError: vi.fn(() => callOrder.push('A')) }
      const obsB = { onStepError: vi.fn(() => callOrder.push('B')) }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }
      const event = { error: new Error('fail'), durationMs: 10 }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onStepError!(stepCtx, event)

      // assert
      expect(callOrder).toEqual(['A', 'B'])
      expect(obsA.onStepError).toHaveBeenCalledWith(stepCtx, event)
      expect(obsB.onStepError).toHaveBeenCalledWith(stepCtx, event)
    })

    it('calls A then B on onInterrupt, forwarding same references', () => {
      // arrange
      const callOrder: string[] = []
      const obsA = { onInterrupt: vi.fn(() => callOrder.push('A')) }
      const obsB = { onInterrupt: vi.fn(() => callOrder.push('B')) }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }
      const event = { prompt: { msg: 'proceed?' }, interruptId: 'int-42' }

      // act
      const composed = composeObservers(obsA, obsB)
      composed.onInterrupt!(stepCtx, event)

      // assert
      expect(callOrder).toEqual(['A', 'B'])
      expect(obsA.onInterrupt).toHaveBeenCalledWith(stepCtx, event)
      expect(obsB.onInterrupt).toHaveBeenCalledWith(stepCtx, event)
    })

  })

  describe('edge cases — empty and shape invariants', () => {

    it('returns a no-op observer when called with zero arguments', () => {
      // arrange
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }

      // act
      const composed = composeObservers()

      // assert
      expect(() => composed.onRunStart!({ agentId: 'a', sessionId: 's' })).not.toThrow()
      expect(() => composed.onStepStart!(stepCtx)).not.toThrow()
      expect(() => composed.onStepEnd!(stepCtx, { durationMs: 0 })).not.toThrow()
      expect(() => composed.onStepError!(stepCtx, { error: new Error(), durationMs: 0 })).not.toThrow()
      expect(() => composed.onRunEnd!({ agentId: 'a', sessionId: 's' }, { signal: 'done', durationMs: 0 })).not.toThrow()
      expect(() => composed.onInterrupt!(stepCtx, { prompt: null, interruptId: 'x' })).not.toThrow()
      expect(() => composed.onEvent!(stepCtx, 'test', undefined)).not.toThrow()
    })

    it('returned object has all seven methods as functions regardless of input observers', () => {
      // arrange
      const obsA = { onRunStart: vi.fn() }
      const obsB = { onStepEnd: vi.fn() }

      // act
      const composed = composeObservers(obsA, obsB)

      // assert
      expect(typeof composed.onRunStart).toBe('function')
      expect(typeof composed.onRunEnd).toBe('function')
      expect(typeof composed.onStepStart).toBe('function')
      expect(typeof composed.onStepEnd).toBe('function')
      expect(typeof composed.onStepError).toBe('function')
      expect(typeof composed.onInterrupt).toBe('function')
      expect(typeof composed.onEvent).toBe('function')
    })

    it('returned object is a plain object with no custom prototype', () => {
      // act
      const composed = composeObservers()

      // assert
      expect(Object.getPrototypeOf(composed)).toBe(Object.prototype)
    })

  })

  describe('error propagation', () => {

    it("propagates error from first observer's onStepEnd and does not call second observer", () => {
      // arrange
      const thrownError = new Error('observer failure')
      const obsA = { onStepEnd: vi.fn(() => { throw thrownError }) }
      const obsB = { onStepEnd: vi.fn() }
      const stepCtx: StepContext = { agentId: 'a', sessionId: 's', stepName: 'step' }
      const event = { durationMs: 30 }

      // act
      const composed = composeObservers(obsA, obsB)

      // assert
      expect(() => composed.onStepEnd!(stepCtx, event)).toThrow(thrownError)
      expect(obsA.onStepEnd).toHaveBeenCalledOnce()
      expect(obsB.onStepEnd).not.toHaveBeenCalled()
    })

  })

  describe('input immutability', () => {

    it('does not add or modify properties on input observers', () => {
      // arrange
      const obsA = { onRunStart: vi.fn() }
      const keysBefore = Object.keys(obsA)

      // act
      composeObservers(obsA)

      // assert
      expect(Object.keys(obsA)).toEqual(keysBefore)
      expect(obsA).toEqual({ onRunStart: expect.any(Function) })
    })

  })

})
