import { describe, it, expect, vi } from 'vitest'
import { runLoop, UnknownSignalError, NoNextStepError } from './loop-executor.js'
import { createLoopBuilder, extractLoopDefinition } from './loop-dsl.js'
import type { LoopDefinition } from './loop-dsl.js'
import type { RunContext } from '../agent/observer.js'
// ctx-emit injection tests use the same build helper defined below

// File-level build helper: constructs a LoopDefinition from a builder lambda
function build(
  fn: (l: ReturnType<typeof createLoopBuilder<Record<string, unknown>, Record<string, unknown> & { agentId: string; sessionId: string }>>) => void
): LoopDefinition {
  const builder = createLoopBuilder<Record<string, unknown>, Record<string, unknown> & { agentId: string; sessionId: string }>()
  fn(builder)
  return extractLoopDefinition(builder as Parameters<typeof extractLoopDefinition>[0])
}

describe('runLoop', () => {

  describe('framework field initialization', () => {

    it('initializes $error and $interrupt to null when state has neither key', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { count: 0 }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$error).toBeNull()
      expect(state.$interrupt).toBeNull()
      expect('$error' in state).toBe(true)
      expect('$interrupt' in state).toBe(true)
    })

    it('preserves existing $interrupt when already set in state; $error cleared by successful run', async () => {
      // arrange
      const priorError = new Error('previous failure')
      const runFn = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {
        $error: priorError,
        $interrupt: { interruptId: 'i1', prompt: 'confirm?' },
      }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert — F10: $error is cleared after successful run; $interrupt is preserved
      expect(state.$error).toBeNull()
      expect((state.$interrupt as any /* any: state is untyped Record<string, unknown> */).interruptId).toBe('i1')
    })

  })

  describe('shouldStop guard', () => {

    it('halts immediately when shouldStop returns true before the first step', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('stepA', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }
      const shouldStop = vi.fn().mockReturnValue(true)

      // act
      const result = await runLoop(graph, state, ctx, undefined, shouldStop)

      // assert
      expect(result.paused).toBe(true)
      expect(result.signal).toBeNull()
      expect(result.cursor).toBe('stepA')
      expect(runFn).not.toHaveBeenCalled()
      expect(shouldStop).toHaveBeenCalledOnce()
    })

    it('halts at step B when shouldStop returns false first then true', async () => {
      // arrange
      const runA = vi.fn().mockResolvedValue({ visited: 'A' })
      const runB = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('A', { run: runA })
         .step('B', { run: runB, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }
      const shouldStop = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)

      // act
      const result = await runLoop(graph, state, ctx, undefined, shouldStop)

      // assert
      expect(result.paused).toBe(true)
      expect(result.cursor).toBe('B')
      expect(result.signal).toBeNull()
      expect(runA).toHaveBeenCalledOnce()
      expect(runB).not.toHaveBeenCalled()
      expect(state.visited).toBe('A')
    })

    it('completes normally when no shouldStop is provided', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ done: true })
      const graph = build(l =>
        l.start()
         .step('only', { run: runFn, route: () => 'finish' })
         .on('finish').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('finish')
      expect(result.cursor).toBeNull()
      expect(runFn).toHaveBeenCalledOnce()
    })

  })

  describe('state update application (applyUpdate)', () => {

    it('applies non-empty run return to state and makes it visible in the next step', async () => {
      // arrange
      let capturedStateInB: Record<string, unknown> | undefined
      const runA = vi.fn().mockResolvedValue({ count: 5 })
      const runB = vi.fn().mockImplementation(async (s: Record<string, unknown>) => {
        capturedStateInB = { ...s }
        return {}
      })
      const graph = build(l =>
        l.start()
         .step('A', { run: runA })
         .step('B', { run: runB, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { count: 0 }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.count).toBe(5)
      expect(capturedStateInB!.count).toBe(5)
    })

    it('does not modify state when run returns an empty object', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { name: 'original', value: 42 }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.name).toBe('original')
      expect(state.value).toBe(42)
    })

    it('strips $error key from run return and applies remaining keys', async () => {
      // arrange
      const userError = new Error('user-made error')
      const runFn = vi.fn().mockResolvedValue({ $error: userError, count: 7 })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$error).toBeNull()
      expect(state.count).toBe(7)
    })

    it('strips $interrupt key from run return', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ $interrupt: { interruptId: 'fake', prompt: 'x' } })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$interrupt).toBeNull()
    })

    it('applies a field reducer when schema declares one for the returned field', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ messages: ['y'] })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { messages: ['x'] }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }
      const schema = {
        messages: { reduce: (a: string[], b: string[]) => [...a, ...b] },
      } as unknown as Record<string, import('../harness/state-field.js').FieldDefinition<any>>

      // act
      await runLoop(graph, state, ctx, schema)

      // assert
      expect(state.messages).toEqual(['x', 'y'])
    })

    it('replaces a field directly when schema has no reducer for it', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ name: 'new' })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { name: 'old' }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }
      const schema = { name: {} } as unknown as Record<string, import('../harness/state-field.js').FieldDefinition<any>>

      // act
      await runLoop(graph, state, ctx, schema)

      // assert
      expect(state.name).toBe('new')
    })

    it('replaces a field directly when schema is undefined', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ key: 'value' })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { key: 'old' }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.key).toBe('value')
    })

    it('does not modify state when step has route only and no run', async () => {
      // arrange
      const graph = build(l =>
        l.start()
         .step('decision', { route: () => 'exit' })
         .on('exit').end()
      )
      const state: Record<string, unknown> = { x: 'original' }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.x).toBe('original')
      expect(result.signal).toBe('exit')
    })

  })

  describe('route and signal dispatch', () => {

    it('route receives the state after run update has been applied', async () => {
      // arrange
      let capturedInRoute: Record<string, unknown> | undefined
      const runFn = vi.fn().mockResolvedValue({ flag: true })
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        capturedInRoute = { ...s }
        return 'done'
      })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: routeFn })
         .on('done').end()
      )
      const state: Record<string, unknown> = { flag: false }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedInRoute!.flag).toBe(true)
      expect(routeFn).toHaveBeenCalledWith(expect.objectContaining({ flag: true }))
    })

    it('advances cursor to the .to() target when route emits a matching signal', async () => {
      // arrange
      const runA = vi.fn().mockResolvedValue({ step: 'A' })
      const runB = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('A', { run: runA, route: () => 'continue' })
         .on('continue').to('B')
         .step('B', { run: runB, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(runA).toHaveBeenCalledOnce()
      expect(runB).toHaveBeenCalledOnce()
      expect(result.signal).toBe('done')
    })

    it('terminates with correct LoopResult when route emits a signal matched by .end()', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ result: 42 })
      const graph = build(l =>
        l.start()
         .step('last', { run: runFn, route: () => 'finished' })
         .on('finished').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('finished')
      expect(result.cursor).toBeNull()
      expect(result.paused).toBe(false)
      expect(result.state.result).toBe(42)
    })

    it('throws UnknownSignalError when route emits a signal with no matching .on()', async () => {
      // arrange
      const routeFn = vi.fn().mockReturnValue('mystery')
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'suspect',
        onError: undefined,
        steps: [
          {
            name: 'suspect',
            run: undefined,
            route: routeFn,
            transitions: [],
            errorAware: false,
            next: undefined,
          },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toThrow(UnknownSignalError)
    })

    it('UnknownSignalError carries correct step and signal properties', async () => {
      // arrange
      const routeFn = vi.fn().mockReturnValue('mystery')
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'suspect',
        onError: undefined,
        steps: [
          {
            name: 'suspect',
            run: undefined,
            route: routeFn,
            transitions: [],
            errorAware: false,
            next: undefined,
          },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toMatchObject({ step: 'suspect', signal: 'mystery' })
    })

  })

  describe('next-step advancement (non-route steps)', () => {

    it('advances cursor to the explicit .next() target', async () => {
      // arrange
      const runA = vi.fn().mockResolvedValue({})
      const runTarget = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('A', { run: runA }).next('target')
         .step('skipped', { run: vi.fn().mockResolvedValue({}), route: () => 'done' }).on('done').end()
         .step('target', { run: runTarget, route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(runA).toHaveBeenCalledOnce()
      expect(runTarget).toHaveBeenCalledOnce()
      expect(graph.steps.find(s => s.name === 'skipped')!.run).not.toHaveBeenCalled()
    })

    it('advances to the immediately following step when no explicit .next() is declared', async () => {
      // arrange
      const order: string[] = []
      const runA = vi.fn().mockImplementation(async () => { order.push('A'); return {} })
      const runB = vi.fn().mockImplementation(async () => { order.push('B'); return {} })
      const graph = build(l =>
        l.start()
         .step('A', { run: runA })
         .step('B', { run: runB, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(order).toEqual(['A', 'B'])
      expect(runA).toHaveBeenCalledOnce()
      expect(runB).toHaveBeenCalledOnce()
    })

    it('throws NoNextStepError when last step has no route and no explicit .next()', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({})
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'terminal',
        onError: undefined,
        steps: [
          {
            name: 'terminal',
            run: runFn,
            route: undefined,
            transitions: [],
            errorAware: false,
            next: undefined,
          },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toThrow(NoNextStepError)
    })

    it('NoNextStepError carries correct step property', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({})
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'terminal',
        onError: undefined,
        steps: [
          {
            name: 'terminal',
            run: runFn,
            route: undefined,
            transitions: [],
            errorAware: false,
            next: undefined,
          },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toMatchObject({ step: 'terminal' })
    })

  })

  describe('full loop execution sequences', () => {

    it('single-step loop executes run, routes to .end(), returns correct LoopResult', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ x: 1 })
      const graph = build(l =>
        l.start()
         .step('A', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('done')
      expect(result.paused).toBe(false)
      expect(result.cursor).toBeNull()
      expect(result.state.x).toBe(1)
      expect(runFn).toHaveBeenCalledOnce()
    })

    it('two-step loop with implicit next executes A then B in order, exits with signal', async () => {
      // arrange
      const executionOrder: string[] = []
      const runA = vi.fn().mockImplementation(async () => { executionOrder.push('A'); return { from: 'A' } })
      const runB = vi.fn().mockImplementation(async () => { executionOrder.push('B'); return {} })
      const graph = build(l =>
        l.start()
         .step('A', { run: runA })
         .step('B', { run: runB, route: () => 'end' })
         .on('end').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(executionOrder).toEqual(['A', 'B'])
      expect(result.signal).toBe('end')
      expect(result.paused).toBe(false)
    })

    it('loop-back causes A→B→A→B execution, exits on second pass when route returns "done"', async () => {
      // arrange
      const executionOrder: string[] = []
      const runA = vi.fn().mockImplementation(async () => { executionOrder.push('A'); return {} })
      const runB = vi.fn().mockImplementation(async () => { executionOrder.push('B'); return {} })
      const routeB = vi.fn()
        .mockReturnValueOnce('loop')
        .mockReturnValueOnce('done')
      const graph = build(l =>
        l.start()
         .step('A', { run: runA }).next('B')
         .step('B', { run: runB, route: routeB })
         .on('loop').to('A')
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(executionOrder).toEqual(['A', 'B', 'A', 'B'])
      expect(result.signal).toBe('done')
      expect(routeB).toHaveBeenCalledTimes(2)
      expect(runA).toHaveBeenCalledTimes(2)
    })

    it('decision node (route-only) does not modify state and routes correctly', async () => {
      // arrange
      const runWorker = vi.fn().mockResolvedValue({ result: 99 })
      const graph = build(l =>
        l.start()
         .step('check', { route: (s) => (s as any /* any: state is untyped Record<string, unknown> */).flag ? 'fast' : 'slow' })
         .on('fast').to('worker')
         .on('slow').to('worker')
         .step('worker', { run: runWorker, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { flag: true, marker: 'untouched' }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.marker).toBe('untouched')
      expect(runWorker).toHaveBeenCalledOnce()
      expect(result.signal).toBe('done')
    })

  })

  describe('state reference and ctx passthrough', () => {

    it('LoopResult.state is the same object reference as the input state', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ added: true })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.state).toBe(state)
    })

    it('step.run receives the exact ctx object passed to runLoop', async () => {
      // arrange
      let capturedCtx: unknown
      const runFn = vi.fn().mockImplementation(async (_s: unknown, c: unknown) => {
        capturedCtx = c
        return {}
      })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session', model: { invoke: vi.fn() } }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedCtx).toBe(ctx)
    })

    it('ctx.sessionId value is accessible unchanged inside step.run', async () => {
      // arrange
      let capturedSessionId: unknown
      const runFn = vi.fn().mockImplementation(async (_s: unknown, c: Record<string, unknown>) => {
        capturedSessionId = c.sessionId
        return {}
      })
      const graph = build(l =>
        l.start()
         .step('a', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'abc-123' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedSessionId).toBe('abc-123')
    })

  })

  describe('LoopResult terminal-state invariants', () => {

    it('paused: false result has non-null signal and null cursor', async () => {
      // arrange
      const graph = build(l =>
        l.start()
         .step('a', { run: vi.fn().mockResolvedValue({}), route: () => 'complete' })
         .on('complete').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.paused).toBe(false)
      expect(typeof result.signal).toBe('string')
      expect(result.signal).not.toBeNull()
      expect(result.cursor).toBeNull()
    })

    it('paused: true result has null signal and non-null cursor step name', async () => {
      // arrange
      const graph = build(l =>
        l.start()
         .step('step1', { run: vi.fn().mockResolvedValue({}), route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }
      const shouldStop = vi.fn().mockReturnValue(true)

      // act
      const result = await runLoop(graph, state, ctx, undefined, shouldStop)

      // assert
      expect(result.paused).toBe(true)
      expect(result.signal).toBeNull()
      expect(typeof result.cursor).toBe('string')
      expect(result.cursor).not.toBeNull()
    })

  })

  describe('error class construction invariants', () => {

    it('UnknownSignalError has correct name, instanceof chain, properties, and message', () => {
      // act
      const error = new UnknownSignalError('think', 'mystery')

      // assert
      expect(error.name).toBe('UnknownSignalError')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(UnknownSignalError)
      expect(error.step).toBe('think')
      expect(error.signal).toBe('mystery')
      expect(error.message).toContain('think')
      expect(error.message).toContain('mystery')
    })

    it('NoNextStepError has correct name, instanceof chain, property, and message', () => {
      // act
      const error = new NoNextStepError('action')

      // assert
      expect(error.name).toBe('NoNextStepError')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(NoNextStepError)
      expect(error.step).toBe('action')
      expect(error.message).toContain('action')
    })

  })

  describe('step.run throw propagation', () => {

    it('throw from step.run resolves with $error signal when route opts in via optin: "$error" and handles it; state preserved', async () => {
      // arrange
      const failingRun = vi.fn().mockRejectedValue(new Error('step failure'))
      const graph = build(l =>
        l.start()
         // optin: '$error' declares opt-in: route is called even when run throws
         .step('boom', { optin: '$error', run: failingRun, route: (s) => (s as any /* any: state is untyped Record<string, unknown> */).$error !== null ? 'abort' : 'done' })
         .on('abort').end()
         .on('done').end()
      )
      const state: Record<string, unknown> = { existing: 'value' }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('abort')
      expect(result.paused).toBe(false)
      expect(state.existing).toBe('value')
    })

  })

  describe('$error field lifecycle on run throw', () => {

    it('sets $error to the thrown Error instance when run throws; partial update discarded', async () => {
      // arrange
      const thrownError = new Error('quota exceeded')
      const runFn = vi.fn().mockRejectedValue(thrownError)
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'throw_step',
        onError: undefined,
        steps: [{
          name: 'throw_step',
          run: runFn,
          route: undefined,
          transitions: [],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = { count: 0 }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.paused).toBe(true)
      expect(result.signal).toBe('$error')
      expect(result.cursor).toBe('throw_step')
      expect(result.state.$error).toBe(thrownError)
      expect(result.state.count).toBe(0)
    })

    it('does not apply any state mutation when run throws mid-execution', async () => {
      // arrange
      const runFn = vi.fn().mockImplementation(async () => {
        throw new Error('mid-run failure')
      })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'partial_step',
        onError: undefined,
        steps: [{
          name: 'partial_step',
          run: runFn,
          route: undefined,
          transitions: [],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = { value: 'original' }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.state.value).toBe('original')
      expect(result.state.$error).toBeInstanceOf(Error)
      expect((result.state.$error as Error).message).toBe('mid-run failure')
    })

    it('wraps a non-Error thrown value in new Error(String(value))', async () => {
      // arrange
      const runFn = vi.fn().mockImplementation(async () => { throw 'oops' })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'string_throw',
        onError: undefined,
        steps: [{
          name: 'string_throw',
          run: runFn,
          route: undefined,
          transitions: [],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.state.$error).toBeInstanceOf(Error)
      expect((result.state.$error as Error).message).toBe('oops')
      expect(result.signal).toBe('$error')
      expect(result.paused).toBe(true)
    })

  })

  describe('InterruptPause does not trigger error path', () => {

    it('InterruptPause throw does not set $error and pauses with signal "$interrupt"', async () => {
      // arrange
      const graph = build(l =>
        l.start()
         .step('interruptible', {
           run: async (_s: Record<string, unknown>, ctx: Record<string, unknown> & { agentId: string; sessionId: string }) => {
             await (ctx as any /* any: interrupt is dynamically injected by runLoop, not in the static ctx type */).interrupt('confirm?', 'i1')
             return {}
           },
           route: () => 'done',
         })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('$interrupt')
      expect(result.paused).toBe(true)
      expect(result.state.$error).toBeNull()
      expect(result.state.$interrupt).not.toBeNull()
    })

  })

  describe('$error cleared after successful run; decision nodes do not clear', () => {

    it('route sees $error === null when run succeeds after a prior error', async () => {
      // arrange
      let capturedError: unknown = 'NOT_SET'
      const runFn = vi.fn().mockResolvedValue({})
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        capturedError = s.$error
        return 'done'
      })
      const graph = build(l =>
        l.start()
         .step('recover', { run: runFn, route: routeFn })
         .on('done').end()
      )
      const state: Record<string, unknown> = { $error: new Error('prior failure') }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedError).toBeNull()
      expect(routeFn).toHaveBeenCalledOnce()
    })

    it('decision node (route-only) does not clear $error; route sees $error still set', async () => {
      // arrange
      let capturedErrorInDecision: unknown = 'NOT_SET'
      const graph = build(l =>
        l.start()
         .step('decision', {
           route: (s: Record<string, unknown>) => {
             capturedErrorInDecision = s.$error
             return 'go'
           },
         })
         .on('go').to('worker')
         .step('worker', { run: vi.fn().mockResolvedValue({}), route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { $error: new Error('lingering error') }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedErrorInDecision).toBeInstanceOf(Error)
      expect((capturedErrorInDecision as Error).message).toBe('lingering error')
    })

  })

  describe('per-step route handling of $error', () => {

    it('route opted in via optin: "$error": returns error-aware signal matching .on().to(); cursor advances to target', async () => {
      // arrange
      const throwingRun = vi.fn().mockRejectedValue(new Error('quota exceeded'))
      let capturedRouteError: unknown = 'NOT_SET'
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        capturedRouteError = s.$error
        return s.$error !== null ? 'retry' : 'continue'
      })
      const recoverRun = vi.fn().mockResolvedValue({ recovered: true })
      const graph = build(l =>
        l.start()
         .step('think', { optin: '$error', run: throwingRun, route: routeFn })
         .on('retry').to('recover')
         .on('continue').to('recover')
         .step('recover', { run: recoverRun, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(throwingRun).toHaveBeenCalledOnce()
      expect(routeFn).toHaveBeenCalledOnce()
      expect(capturedRouteError).toBeInstanceOf(Error)
      expect(recoverRun).toHaveBeenCalledOnce()
      expect(result.signal).toBe('done')
      expect(result.paused).toBe(false)
    })

    it('route opted in via optin: "$error": returns signal matched by .on().end(); resolves with that signal; $error remains in state', async () => {
      // arrange
      const thrownError = new Error('fatal failure')
      const runFn = vi.fn().mockRejectedValue(thrownError)
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        return s.$error !== null ? 'fatal' : 'continue'
      })
      const graph = build(l =>
        l.start()
         .step('action', { optin: '$error', run: runFn, route: routeFn })
         .on('fatal').end()
         .on('continue').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('fatal')
      expect(result.paused).toBe(false)
      expect(result.cursor).toBeNull()
      expect(result.state.$error).toBe(thrownError)
    })

    it('route WITHOUT .on("$error") opt-in: route is bypassed when run throws; pauses with $error', async () => {
      // arrange — route always returns 'continue' but step has no .on('$error') opt-in
      const runFn = vi.fn().mockRejectedValue(new Error('step failed'))
      const routeFn = vi.fn().mockReturnValue('continue')
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'work',
        onError: undefined,
        steps: [{
          name: 'work',
          run: runFn,
          route: routeFn,
          transitions: [{ signal: 'continue', target: { kind: 'step', name: 'work' } }],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert — route was NOT called; error fell through to $error pause
      expect(routeFn).not.toHaveBeenCalled()
      expect(result.signal).toBe('$error')
      expect(result.paused).toBe(true)
      expect(result.cursor).toBe('work')
      expect(result.state.$error).toBeInstanceOf(Error)
    })

    it('route opted in via optin: "$error" returns an unhandled signal after run throws → UnknownSignalError thrown', async () => {
      // arrange — step opts in but route returns a signal with no matching transition
      const runFn = vi.fn().mockRejectedValue(new Error('step failed'))
      const routeFn = vi.fn().mockReturnValue('unknown_signal')
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'flawed',
        onError: undefined,
        steps: [{
          name: 'flawed',
          run: runFn,
          route: routeFn,
          transitions: [],
          errorAware: true,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const err = await runLoop(graph, state, ctx, undefined).catch(e => e)

      // assert
      expect(err).toBeInstanceOf(UnknownSignalError)
      expect(err.step).toBe('flawed')
      expect(err.signal).toBe('unknown_signal')
    })

  })

  describe('l.onError() fallback', () => {

    it('step with no route and l.onError() declared: cursor moves to onError step; execution continues', async () => {
      // arrange
      const throwingRun = vi.fn().mockRejectedValue(new Error('worker failed'))
      const handlerRun = vi.fn().mockResolvedValue({ handled: true })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'worker',
        onError: 'handle_error',
        steps: [
          { name: 'worker', run: throwingRun, route: undefined, transitions: [], errorAware: false, next: undefined },
          { name: 'handle_error', run: handlerRun, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(throwingRun).toHaveBeenCalledOnce()
      expect(handlerRun).toHaveBeenCalledOnce()
      expect(result.signal).toBe('done')
      expect(result.paused).toBe(false)
      expect(result.state.$error).toBeNull()
    })

    it('step with no route and no l.onError(): resolves with signal "$error" and paused: true', async () => {
      // arrange
      const thrownError = new Error('unhandled domain error')
      const runFn = vi.fn().mockRejectedValue(thrownError)
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'no_handler',
        onError: undefined,
        steps: [{
          name: 'no_handler',
          run: runFn,
          route: undefined,
          transitions: [],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = { count: 5 }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('$error')
      expect(result.paused).toBe(true)
      expect(result.cursor).toBe('no_handler')
      expect(result.state.$error).toBe(thrownError)
      expect(result.state.count).toBe(5)
    })

    it('step with route WITHOUT .on("$error") opt-in: route bypassed; l.onError() step IS reached', async () => {
      // arrange — route returns 'continue' blindly but has no .on('$error') opt-in
      const throwingRun = vi.fn().mockRejectedValue(new Error('domain error'))
      const routeFn = vi.fn().mockReturnValue('continue')
      const handleErrorRun = vi.fn().mockResolvedValue({})
      const nextRun = vi.fn().mockResolvedValue({})
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'work',
        onError: 'handle_error',
        steps: [
          { name: 'work', run: throwingRun, route: routeFn,
            transitions: [{ signal: 'continue', target: { kind: 'step', name: 'next_step' } }],
            errorAware: false,
            next: undefined },
          { name: 'next_step', run: nextRun, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
          { name: 'handle_error', run: handleErrorRun, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert — route was NOT called; l.onError() step was reached instead
      expect(throwingRun).toHaveBeenCalledOnce()
      expect(routeFn).not.toHaveBeenCalled()
      expect(nextRun).not.toHaveBeenCalled()
      expect(handleErrorRun).toHaveBeenCalledOnce()
      expect(result.signal).toBe('done')
    })

    it('step with route WITH optin: "$error" and l.onError(): route takes precedence; l.onError() step NOT reached', async () => {
      // arrange — route opts in via errorAware: true and handles error by routing to 'next_step'
      const throwingRun = vi.fn().mockRejectedValue(new Error('domain error'))
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) =>
        s.$error !== null ? 'continue' : 'continue'
      )
      const handleErrorRun = vi.fn().mockResolvedValue({})
      const nextRun = vi.fn().mockResolvedValue({})
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'work',
        onError: 'handle_error',
        steps: [
          { name: 'work', run: throwingRun, route: routeFn,
            transitions: [
              { signal: 'continue', target: { kind: 'step', name: 'next_step' } },
            ],
            errorAware: true,
            next: undefined },
          { name: 'next_step', run: nextRun, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
          { name: 'handle_error', run: handleErrorRun, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert — route WAS called; l.onError() step was NOT reached
      expect(throwingRun).toHaveBeenCalledOnce()
      expect(routeFn).toHaveBeenCalledOnce()
      expect(nextRun).toHaveBeenCalledOnce()
      expect(handleErrorRun).not.toHaveBeenCalled()
      expect(result.signal).toBe('done')
    })

  })

  describe('shouldStop() interaction with error path', () => {

    it('shouldStop() is not consulted when run throws; error routing proceeds regardless', async () => {
      // arrange
      const runFn = vi.fn().mockRejectedValue(new Error('domain failure'))
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'work',
        onError: undefined,
        steps: [{ name: 'work', run: runFn, route: undefined, transitions: [], errorAware: false, next: undefined }],
      }
      const shouldStop = vi.fn().mockReturnValue(false)
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined, shouldStop)

      // assert
      expect(result.signal).toBe('$error')
      expect(result.paused).toBe(true)
      expect(shouldStop).toHaveBeenCalledOnce()
      expect(result.state.$error).toBeInstanceOf(Error)
    })

    it('shouldStop() checked normally at next iteration top after successful step; $error remains null', async () => {
      // arrange
      const runA = vi.fn().mockResolvedValue({})
      const runB = vi.fn().mockResolvedValue({})
      const graph = build(l =>
        l.start()
         .step('A', { run: runA })
         .step('B', { run: runB, route: () => 'done' })
         .on('done').end()
      )
      const shouldStop = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined, shouldStop)

      // assert
      expect(result.paused).toBe(true)
      expect(result.signal).toBeNull()
      expect(result.cursor).toBe('B')
      expect(result.state.$error).toBeNull()
      expect(runB).not.toHaveBeenCalled()
    })

  })

  describe('route throwing (defensive catch)', () => {

    it('route throws after successful run: state update stands; $error set to route error; paused: true', async () => {
      // arrange
      const routeError = new Error('route failure')
      const runFn = vi.fn().mockResolvedValue({ count: 10 })
      const routeFn = vi.fn().mockImplementation(() => { throw routeError })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'action',
        onError: undefined,
        steps: [{
          name: 'action',
          run: runFn,
          route: routeFn,
          transitions: [],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = { count: 0 }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('$error')
      expect(result.paused).toBe(true)
      expect(result.cursor).toBe('action')
      expect(result.state.$error).toBe(routeError)
      expect(result.state.count).toBe(10)
    })

    it('run throws then route also throws (route opted in via optin: "$error"): $error overwritten with route error; paused: true', async () => {
      // arrange
      const runError = new Error('run failure')
      const routeError = new Error('route failure')
      const runFn = vi.fn().mockRejectedValue(runError)
      let capturedRunError: unknown = 'NOT_SET'
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        capturedRunError = s.$error
        throw routeError
      })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'double_fail',
        onError: undefined,
        steps: [{
          name: 'double_fail',
          run: runFn,
          route: routeFn,
          transitions: [],
          errorAware: true,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('$error')
      expect(result.paused).toBe(true)
      expect(result.state.$error).toBe(routeError)
      expect(result.state.$error).not.toBe(runError)
      expect(routeFn).toHaveBeenCalledOnce()
      expect(capturedRunError).toBe(runError)
    })

  })

  describe('recovery step behavior', () => {

    it('recovery step run succeeds; $error cleared; subsequent steps see null', async () => {
      // arrange
      const failRun = vi.fn().mockRejectedValue(new Error('initial error'))
      const handlerRun = vi.fn().mockResolvedValue({})
      let capturedErrorInContinue: unknown = 'NOT_SET'
      const continueRun = vi.fn().mockImplementation(async (s: Record<string, unknown>) => {
        capturedErrorInContinue = s.$error
        return {}
      })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'fail_step',
        onError: 'handle_error',
        steps: [
          { name: 'fail_step', run: failRun, route: undefined, transitions: [], errorAware: false, next: undefined },
          { name: 'handle_error', run: handlerRun, route: () => 'next',
            transitions: [{ signal: 'next', target: { kind: 'step', name: 'continue_step' } }], errorAware: false, next: undefined },
          { name: 'continue_step', run: continueRun, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedErrorInContinue).toBeNull()
      expect(result.signal).toBe('done')
    })

    it('recovery step run also throws; $error updated; routes via its route (opted in) to bail out', async () => {
      // arrange
      const workError = new Error('work failed')
      const handlerError = new Error('handler also failed')
      const workRun = vi.fn().mockRejectedValue(workError)
      const handlerRun = vi.fn().mockRejectedValue(handlerError)
      const handleRoute = vi.fn().mockReturnValue('bail')
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'work',
        onError: 'handle_error',
        steps: [
          { name: 'work', run: workRun, route: undefined, transitions: [], errorAware: false, next: undefined },
          { name: 'handle_error', run: handlerRun, route: handleRoute,
            transitions: [
              { signal: 'bail', target: { kind: 'end' } },
            ], errorAware: true, next: undefined },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(workRun).toHaveBeenCalledOnce()
      expect(handlerRun).toHaveBeenCalledOnce()
      expect(handleRoute).toHaveBeenCalledOnce()
      expect(handleRoute).toHaveBeenCalledWith(expect.objectContaining({ $error: handlerError }))
      expect(result.signal).toBe('bail')
      expect(result.state.$error).toBe(handlerError)
    })

  })

  describe('$interruptResponses not affected by error path', () => {

    it('$interruptResponses is not cleared when run throws', async () => {
      // arrange
      const runFn = vi.fn().mockRejectedValue(new Error('step failed during resume'))
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'resume_step',
        onError: undefined,
        steps: [{
          name: 'resume_step',
          run: runFn,
          route: undefined,
          transitions: [],
          errorAware: false,
          next: undefined,
        }],
      }
      const state: Record<string, unknown> = {
        $interruptResponses: { 'i1': 'user response' },
      }
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.state.$interruptResponses).toEqual({ 'i1': 'user response' })
      expect(result.state.$error).toBeInstanceOf(Error)
      expect(result.signal).toBe('$error')
    })

  })

  describe('full loop sequences with error routing', () => {

    it('A throws → onError to B → B succeeds → B routes to C → C ends; resolves cleanly', async () => {
      // arrange
      const runA = vi.fn().mockRejectedValue(new Error('A failed'))
      const runB = vi.fn().mockResolvedValue({ recovered: true })
      const runC = vi.fn().mockResolvedValue({ final: true })
      let capturedBState: Record<string, unknown> | null = null
      const routeB = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        capturedBState = { ...s }
        return 'next'
      })
      const graph: LoopDefinition = {
        startCalled: true,
        entryStep: 'A',
        onError: 'B',
        steps: [
          { name: 'A', run: runA, route: undefined, transitions: [], errorAware: false, next: undefined },
          { name: 'B', run: runB, route: routeB,
            transitions: [{ signal: 'next', target: { kind: 'step', name: 'C' } }], errorAware: false, next: undefined },
          { name: 'C', run: runC, route: () => 'done',
            transitions: [{ signal: 'done', target: { kind: 'end' } }], errorAware: false, next: undefined },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(runA).toHaveBeenCalledOnce()
      expect(runB).toHaveBeenCalledOnce()
      expect(runC).toHaveBeenCalledOnce()
      expect(capturedBState!.$error).toBeNull()
      expect(result.signal).toBe('done')
      expect(result.paused).toBe(false)
      expect(result.cursor).toBeNull()
    })

    it('run throws; route opted in via optin: "$error" exits with a custom signal; $error remains in LoopResult.state', async () => {
      // arrange
      const thrownError = new Error('domain throw treated as complete')
      const runFn = vi.fn().mockRejectedValue(thrownError)
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => {
        return s.$error !== null ? 'complete' : 'normal'
      })
      const graph = build(l =>
        l.start()
         .step('A', { optin: '$error', run: runFn, route: routeFn })
         .on('complete').end()
         .on('normal').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test-session' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('complete')
      expect(result.paused).toBe(false)
      expect(result.cursor).toBeNull()
      expect(result.state.$error).toBe(thrownError)
    })

  })

  describe('ctx.emit injection', () => {

    it("step's ctx.emit calls the registered listener", async () => {
      // arrange
      const fn = vi.fn()
      const graph = build(l => l.start()
        .step('go', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('x', 'value'); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test' }
      const callbacks = { listeners: { 'x': fn } }

      // act
      await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith('value')
    })

    it('unregistered name is a no-op and execution continues normally', async () => {
      // arrange
      const fn = vi.fn()
      const graph = build(l => l.start()
        .step('go', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('y', 'other'); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test' }
      const callbacks = { listeners: { 'x': fn } }

      // act
      const result = await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(fn).not.toHaveBeenCalled()
      expect(result.signal).toBe('done')
    })

    it('ctx.emit is a no-op when no callbacks argument is provided', async () => {
      // arrange
      const graph = build(l => l.start()
        .step('go', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('x', 'payload'); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test' }

      // act
      const result = await runLoop(graph, state, ctx, undefined, undefined, undefined, undefined)

      // assert
      expect(result.signal).toBe('done')
    })

    it('ctx.emit is a no-op when callbacks has no listeners key', async () => {
      // arrange
      const graph = build(l => l.start()
        .step('go', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('x', 'payload'); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test' }
      const callbacks = {}

      // act
      const result = await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(result.signal).toBe('done')
    })

    it('listener is called twice when two steps both emit the same event name', async () => {
      // arrange
      const fn = vi.fn()
      const graph = build(l => l.start()
        .step('stepA', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('e', 1); return {} },
        })
        .next('stepB')
        .step('stepB', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('e', 2); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test' }
      const callbacks = { listeners: { 'e': fn } }

      // act
      await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(fn).toHaveBeenCalledTimes(2)
      expect(fn).toHaveBeenNthCalledWith(1, 1)
      expect(fn).toHaveBeenNthCalledWith(2, 2)
    })

    it('ctx.emit is available in the first step (injection precedes the while loop)', async () => {
      // arrange
      const fn = vi.fn()
      const graph = build(l => l.start()
        .step('first', {
          run: async (_s, ctx) => { (ctx as Record<string, unknown> & { sessionId: string; emit: (name: string, payload?: unknown) => void }).emit('ready', true); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'test-agent', sessionId: 'test' }
      const callbacks = { listeners: { 'ready': fn } }

      // act
      await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith(true)
    })

    it('ctx.interrupt and ctx.emit are both available in the first step', async () => {
      // arrange
      const emitFn = vi.fn()
      const state: Record<string, unknown> = { $interruptResponses: { '$auto:0': 'response' } }
      const graph = build(l => l.start()
        .step('go', {
          run: async (_s, ctx) => {
            const typedCtx = ctx as Record<string, unknown> & { sessionId: string; interrupt: (prompt: unknown, id?: string) => Promise<unknown>; emit: (name: string, payload?: unknown) => void }
            const answer = await typedCtx.interrupt('prompt?')
            typedCtx.emit('done', answer)
            return {}
          },
          route: () => 'end',
        })
        .on('end').end()
      )
      const ctx = { agentId: 'test-agent', sessionId: 'test' }
      const callbacks = { listeners: { 'done': emitFn } }

      // act
      const result = await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(result.signal).toBe('end')
      expect(emitFn).toHaveBeenCalledOnce()
      expect(emitFn).toHaveBeenCalledWith('response')
    })

  })

  describe('observer — run-level lifecycle', () => {

    it('calls onRunStart exactly once with RunContext before any step executes', async () => {
      // arrange
      const callOrder: string[] = []
      const runFn = vi.fn().mockImplementation(async () => { callOrder.push('step'); return {} })
      const obs = {
        onRunStart: vi.fn().mockImplementation(() => callOrder.push('onRunStart')),
      }
      const graph = build(l =>
        l.start().step('a', { run: runFn, route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(obs.onRunStart).toHaveBeenCalledOnce()
      expect(obs.onRunStart).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ag-1', sessionId: 'ses-1', runId: expect.any(String) }))
      expect(callOrder[0]).toBe('onRunStart')
    })

    it('calls onRunEnd once with exit signal and non-negative durationMs on normal completion', async () => {
      // arrange
      const onRunEnd = vi.fn()
      const obs = { onRunEnd }
      const graph = build(l =>
        l.start().step('a', { run: async () => ({}), route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(onRunEnd).toHaveBeenCalledOnce()
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'ag-1', sessionId: 'ses-1', runId: expect.any(String) }),
        expect.objectContaining({ signal: 'done', durationMs: expect.any(Number) }),
      )
      const { durationMs } = (onRunEnd.mock.calls[0] as [unknown, { durationMs: number }])[1]
      expect(durationMs).toBeGreaterThanOrEqual(0)
    })

    it('calls onRunStart then onRunEnd with $stopped when shouldStop is true on first check', async () => {
      // arrange
      const onRunStart = vi.fn()
      const onRunEnd = vi.fn()
      const stepRun = vi.fn()
      const obs = { onRunStart, onRunEnd }
      const graph = build(l =>
        l.start().step('a', { run: stepRun, route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}
      const shouldStop = () => true

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, shouldStop, undefined, { observer: obs })

      // assert
      expect(onRunStart).toHaveBeenCalledOnce()
      expect(stepRun).not.toHaveBeenCalled()
      expect(onRunEnd).toHaveBeenCalledOnce()
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: '$stopped', durationMs: expect.any(Number) }),
      )
    })

    it('calls onInterrupt then onRunEnd with $interrupt when ctx.interrupt() fires', async () => {
      // arrange
      const callOrder: string[] = []
      const onInterrupt = vi.fn().mockImplementation(() => callOrder.push('onInterrupt'))
      const onRunEnd = vi.fn().mockImplementation(() => callOrder.push('onRunEnd'))
      const obs = { onInterrupt, onRunEnd }
      const graph = build(l =>
        l.start().step('a', {
          run: async (_s: unknown, c: any) => { await c.interrupt({ prompt: 'confirm?' }); return {} }, // any: ctx is untyped in test helper
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      const result = await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(result.signal).toBe('$interrupt')
      expect(onInterrupt).toHaveBeenCalledOnce()
      expect(onInterrupt).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'a' }),
        expect.objectContaining({ prompt: { prompt: 'confirm?' }, interruptId: expect.any(String) }),
      )
      expect(onRunEnd).toHaveBeenCalledOnce()
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: '$interrupt' }),
      )
      expect(callOrder).toEqual(['onInterrupt', 'onRunEnd'])
    })

    it('calls onRunEnd with $error when step throws a non-interrupt error (no graph.onError)', async () => {
      // arrange
      const onRunEnd = vi.fn()
      const obs = { onRunEnd }
      const graph = build(l =>
        l.start().step('a', {
          run: async () => { throw new Error('domain error') },
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      const result = await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(result.signal).toBe('$error')
      expect(onRunEnd).toHaveBeenCalledOnce()
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: '$error', durationMs: expect.any(Number) }),
      )
    })

    it('makes no observer calls and behaves identically to pre-F16b when callbacks.observer is absent', async () => {
      // arrange
      const onComplete = vi.fn()
      const graph = build(l =>
        l.start().step('a', { run: async () => ({}), route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act + assert — no throw, existing hook still fires
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { onComplete })
      expect(onComplete).toHaveBeenCalledOnce()
    })

  })

  describe('observer — step-level lifecycle', () => {

    it('calls onStepStart before run and onStepEnd after applyUpdate with durationMs≥0', async () => {
      // arrange
      const callOrder: string[] = []
      const onStepStart = vi.fn().mockImplementation(() => callOrder.push('onStepStart'))
      const onStepEnd = vi.fn().mockImplementation(() => callOrder.push('onStepEnd'))
      const obs = { onStepStart, onStepEnd }
      const graph = build(l =>
        l.start().step('step-a', { run: async () => ({ x: 1 }), route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(onStepStart).toHaveBeenCalledOnce()
      expect(onStepStart).toHaveBeenCalledWith({ agentId: 'ag-1', sessionId: 'ses-1', stepName: 'step-a' })
      expect(onStepEnd).toHaveBeenCalledOnce()
      expect(onStepEnd).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'step-a' }),
        expect.objectContaining({ durationMs: expect.any(Number) }),
      )
      const { durationMs } = (onStepEnd.mock.calls[0] as [unknown, { durationMs: number }])[1]
      expect(durationMs).toBeGreaterThanOrEqual(0)
      expect(callOrder).toEqual(['onStepStart', 'onStepEnd'])
    })

    it('calls onStepStart and onStepError but NOT onStepEnd when step.run throws', async () => {
      // arrange
      const onStepStart = vi.fn()
      const onStepEnd = vi.fn()
      const onStepError = vi.fn()
      const obs = { onStepStart, onStepEnd, onStepError }
      const domainError = new Error('step failed')
      const graph = build(l =>
        l.start().step('step-a', {
          run: async () => { throw domainError },
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      const result = await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(result.signal).toBe('$error')
      expect(onStepStart).toHaveBeenCalledOnce()
      expect(onStepError).toHaveBeenCalledOnce()
      expect(onStepError).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'step-a' }),
        expect.objectContaining({ error: domainError, durationMs: expect.any(Number) }),
      )
      expect(onStepEnd).not.toHaveBeenCalled()
    })

    it('calls onStepStart but NOT onStepEnd or onStepError when step calls ctx.interrupt()', async () => {
      // arrange
      const onStepStart = vi.fn()
      const onStepEnd = vi.fn()
      const onStepError = vi.fn()
      const obs = { onStepStart, onStepEnd, onStepError }
      const graph = build(l =>
        l.start().step('step-a', {
          run: async (_s: unknown, c: any) => { await c.interrupt({ prompt: 'pause' }); return {} }, // any: ctx is untyped in test helper
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(onStepStart).toHaveBeenCalledOnce()
      expect(onStepEnd).not.toHaveBeenCalled()
      expect(onStepError).not.toHaveBeenCalled()
    })

    it('calls onStepStart but NOT onStepEnd for a decision-only step (no run function)', async () => {
      // arrange
      const onStepStart = vi.fn()
      const onStepEnd = vi.fn()
      const obs = { onStepStart, onStepEnd }
      const graph = build(l =>
        l.start()
         .step('decide', { route: (s: any) => s.go ? 'done' : 'done' }) // any: untyped state in test
         .on('done').end()
      )
      const state: Record<string, unknown> = { go: true }

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(onStepStart).toHaveBeenCalledOnce()
      expect(onStepStart).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'decide' }))
      expect(onStepEnd).not.toHaveBeenCalled()
    })

    it('fires onStepStart and onStepEnd exactly once per step, interleaved, in a 2-step loop', async () => {
      // arrange
      const callOrder: string[] = []
      const obs = {
        onStepStart: vi.fn().mockImplementation((ctx: any) => callOrder.push(`start:${ctx.stepName}`)), // any: ctx narrowed by name access
        onStepEnd:   vi.fn().mockImplementation((ctx: any) => callOrder.push(`end:${ctx.stepName}`)),   // any: see onStepStart
      }
      const graph = build(l =>
        l.start()
         .step('step-a', { run: async () => ({}) })
         .step('step-b', { run: async () => ({}), route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(obs.onStepStart).toHaveBeenCalledTimes(2)
      expect(obs.onStepEnd).toHaveBeenCalledTimes(2)
      expect(callOrder).toEqual(['start:step-a', 'end:step-a', 'start:step-b', 'end:step-b'])
    })

  })

  describe('observer — ctx.emit fan-out', () => {

    it('fires both listener and observer.onEvent when ctx.emit is called in a step', async () => {
      // arrange
      const listenerFn = vi.fn()
      const onEvent = vi.fn()
      const obs = { onEvent }
      const graph = build(l =>
        l.start().step('step-a', {
          run: async (_s: unknown, c: any) => { c.emit('e', 42); return {} }, // any: ctx is untyped in test helper
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs, listeners: { e: listenerFn } })

      // assert
      expect(listenerFn).toHaveBeenCalledOnce()
      expect(listenerFn).toHaveBeenCalledWith(42)
      expect(onEvent).toHaveBeenCalledOnce()
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'step-a' }), 'e', 42)
    })

    it('fires observer.onEvent even when no listener is registered for the event name', async () => {
      // arrange
      const onEvent = vi.fn()
      const obs = { onEvent }
      const graph = build(l =>
        l.start().step('step-a', {
          run: async (_s: unknown, c: any) => { c.emit('custom.event', { x: 1 }); return {} }, // any: ctx is untyped in test helper
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(onEvent).toHaveBeenCalledOnce()
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'step-a' }), 'custom.event', { x: 1 })
    })

    it('sets stepName in onEvent StepContext to the step that called ctx.emit', async () => {
      // arrange
      const capturedStepNames: string[] = []
      const obs = {
        onEvent: vi.fn().mockImplementation((ctx: any) => capturedStepNames.push(ctx.stepName)), // any: ctx narrowed by name access
      }
      const graph = build(l =>
        l.start()
         .step('step-a', {
           run: async (_s: unknown, c: any) => { c.emit('ev', 'from-a'); return {} }, // any: ctx is untyped in test helper
         })
         .step('step-b', {
           run: async (_s: unknown, c: any) => { c.emit('ev', 'from-b'); return {} }, // any: ctx is untyped in test helper
           route: () => 'done',
         })
         .on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(obs.onEvent).toHaveBeenCalledTimes(2)
      expect(capturedStepNames).toEqual(['step-a', 'step-b'])
    })

    it('fires only matching listener when no observer is present on ctx.emit', async () => {
      // arrange
      const listenerFn = vi.fn()
      const graph = build(l =>
        l.start().step('step-a', {
          run: async (_s: unknown, c: any) => { c.emit('e', 'payload'); return {} }, // any: ctx is untyped in test helper
          route: () => 'done',
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { listeners: { e: listenerFn } })

      // assert
      expect(listenerFn).toHaveBeenCalledOnce()
      expect(listenerFn).toHaveBeenCalledWith('payload')
    })

  })

  describe('observer — runId and parentRunId threading', () => {

    it('passes runId from callbacks to RunContext at onRunStart', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: RunContext) => capturedCtx.push(ctx)) }
      const graph = build(l =>
        l.start()
         .step('go', { route: () => 'done' })
         .on('done').end()
      )
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, {
        observer,
        runId: 'explicit-run-id',
      })

      // assert
      expect(capturedCtx).toHaveLength(1)
      expect(capturedCtx[0]!.runId).toBe('explicit-run-id')
    })

    it('passes runId from callbacks to RunContext at onRunEnd with same value', async () => {
      // arrange
      const startCtx: RunContext[] = []
      const endCtx: RunContext[] = []
      const observer = {
        onRunStart: vi.fn((ctx: RunContext) => startCtx.push(ctx)),
        onRunEnd: vi.fn((ctx: RunContext) => endCtx.push(ctx)),
      }
      const graph = build(l =>
        l.start()
         .step('go', { route: () => 'done' })
         .on('done').end()
      )
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, {
        observer,
        runId: 'explicit-run-id',
      })

      // assert
      expect(startCtx[0]!.runId).toBe(endCtx[0]!.runId)
      expect(startCtx[0]!.runId).toBe('explicit-run-id')
    })

    it('uses empty string as fallback when callbacks.runId is absent', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: RunContext) => capturedCtx.push(ctx)) }
      const graph = build(l =>
        l.start()
         .step('go', { route: () => 'done' })
         .on('done').end()
      )
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, { observer })

      // assert
      expect(capturedCtx[0]!.runId).toBe('')
    })

    it('passes parentRunId from callbacks to RunContext', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: RunContext) => capturedCtx.push(ctx)) }
      const graph = build(l =>
        l.start()
         .step('go', { route: () => 'done' })
         .on('done').end()
      )
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, {
        observer,
        runId: 'run-1',
        parentRunId: 'parent-xyz',
      })

      // assert
      expect(capturedCtx[0]!.parentRunId).toBe('parent-xyz')
    })

    it('omits parentRunId from RunContext when callbacks.parentRunId is absent', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: RunContext) => capturedCtx.push(ctx)) }
      const graph = build(l =>
        l.start()
         .step('go', { route: () => 'done' })
         .on('done').end()
      )
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, {
        observer,
        runId: 'run-1',
      })

      // assert
      expect(capturedCtx[0]!.parentRunId).toBeUndefined()
      expect('parentRunId' in capturedCtx[0]!).toBe(false)
    })

    it('preserves parentRunId across onRunStart and onRunEnd', async () => {
      // arrange
      const startCtx: RunContext[] = []
      const endCtx: RunContext[] = []
      const observer = {
        onRunStart: vi.fn((ctx: RunContext) => startCtx.push(ctx)),
        onRunEnd: vi.fn((ctx: RunContext) => endCtx.push(ctx)),
      }
      const graph = build(l =>
        l.start()
         .step('go', { route: () => 'done' })
         .on('done').end()
      )
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, {
        observer,
        runId: 'run-1',
        parentRunId: 'parent-abc',
      })

      // assert
      expect(startCtx[0]!.parentRunId).toBe('parent-abc')
      expect(endCtx[0]!.parentRunId).toBe('parent-abc')
    })

  })

  describe('observer — ordering invariants', () => {

    it('onRunStart fires before the first onStepStart; onRunEnd fires after the last onStepEnd', async () => {
      // arrange
      const callOrder: string[] = []
      const obs = {
        onRunStart:  vi.fn().mockImplementation(() => callOrder.push('onRunStart')),
        onRunEnd:    vi.fn().mockImplementation(() => callOrder.push('onRunEnd')),
        onStepStart: vi.fn().mockImplementation(() => callOrder.push('onStepStart')),
        onStepEnd:   vi.fn().mockImplementation(() => callOrder.push('onStepEnd')),
      }
      const graph = build(l =>
        l.start().step('a', { run: async () => ({}), route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(callOrder).toEqual(['onRunStart', 'onStepStart', 'onStepEnd', 'onRunEnd'])
    })

    it('per-step order is onStepStart → step.run executes → onStepEnd → routing', async () => {
      // arrange
      const callOrder: string[] = []
      const obs = {
        onStepStart: vi.fn().mockImplementation(() => callOrder.push('onStepStart')),
        onStepEnd:   vi.fn().mockImplementation(() => callOrder.push('onStepEnd')),
      }
      const graph = build(l =>
        l.start().step('a', {
          run: vi.fn().mockImplementation(async () => { callOrder.push('step.run'); return {} }),
          route: (_s: any) => { callOrder.push('route'); return 'done' }, // any: untyped state in test
        }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { observer: obs })

      // assert
      expect(callOrder).toEqual(['onStepStart', 'step.run', 'onStepEnd', 'route'])
    })

    it('onBeforeStep fires before observer.onStepStart', async () => {
      // arrange
      const callOrder: string[] = []
      const onBeforeStep = vi.fn().mockImplementation(() => callOrder.push('onBeforeStep'))
      const onStepStart  = vi.fn().mockImplementation(() => callOrder.push('onStepStart'))
      const graph = build(l =>
        l.start().step('a', { run: async () => ({}), route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { onBeforeStep, observer: { onStepStart } })

      // assert
      expect(callOrder[0]).toBe('onBeforeStep')
      expect(callOrder[1]).toBe('onStepStart')
    })

    it('onAfterStep fires before observer.onStepEnd', async () => {
      // arrange
      const callOrder: string[] = []
      const onAfterStep = vi.fn().mockImplementation(() => callOrder.push('onAfterStep'))
      const onStepEnd   = vi.fn().mockImplementation(() => callOrder.push('onStepEnd'))
      const graph = build(l =>
        l.start().step('a', { run: async () => ({}), route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}

      // act
      await runLoop(graph, state, { agentId: 'ag-1', sessionId: 'ses-1' }, undefined, undefined, undefined, { onAfterStep, observer: { onStepEnd } })

      // assert
      expect(callOrder[0]).toBe('onAfterStep')
      expect(callOrder[1]).toBe('onStepEnd')
    })

  })

})
