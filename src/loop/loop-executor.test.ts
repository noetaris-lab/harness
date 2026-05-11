import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runLoop, UnknownSignalError, NoNextStepError } from './loop-executor.js'
import { createLoopBuilder, extractLoopDefinition } from './loop-dsl.js'
import type { LoopDefinition } from './loop-dsl.js'

// File-level build helper: constructs a LoopDefinition from a builder lambda
function build(
  fn: (l: ReturnType<typeof createLoopBuilder<Record<string, unknown>, Record<string, unknown> & { sessionId: string }>>) => void
): LoopDefinition {
  const builder = createLoopBuilder<Record<string, unknown>, Record<string, unknown> & { sessionId: string }>()
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
      const ctx = { sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$error).toBeNull()
      expect(state.$interrupt).toBeNull()
      expect('$error' in state).toBe(true)
      expect('$interrupt' in state).toBe(true)
    })

    it('preserves existing $error and $interrupt when already set in state', async () => {
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
      const ctx = { sessionId: 'test-session' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$error).toBe(priorError)
      expect((state.$interrupt as any).interruptId).toBe('i1')
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
      const ctx = { sessionId: 'test-session' }
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
      const ctx = { sessionId: 'test-session' }
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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }
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
      const ctx = { sessionId: 'test-session' }
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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
            next: undefined,
          },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toThrow(UnknownSignalError)

      let caught: UnknownSignalError | undefined
      try {
        await runLoop(graph, state, ctx, undefined)
      } catch (e) {
        caught = e as UnknownSignalError
      }
      expect(caught!.step).toBe('suspect')
      expect(caught!.signal).toBe('mystery')
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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
            next: undefined,
          },
        ],
      }
      const state: Record<string, unknown> = {}
      const ctx = { sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toThrow(NoNextStepError)

      let caught: NoNextStepError | undefined
      try {
        await runLoop(graph, state, ctx, undefined)
      } catch (e) {
        caught = e as NoNextStepError
      }
      expect(caught!.step).toBe('terminal')
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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
         .step('check', { route: (s) => (s as any).flag ? 'fast' : 'slow' })
         .on('fast').to('worker')
         .on('slow').to('worker')
         .step('worker', { run: runWorker, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { flag: true, marker: 'untouched' }
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session', model: { invoke: vi.fn() } }

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
      const ctx = { sessionId: 'abc-123' }

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
      const ctx = { sessionId: 'test-session' }

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
      const ctx = { sessionId: 'test-session' }
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

    it('unhandled throw from step.run rejects the runLoop promise and leaves state unchanged', async () => {
      // arrange
      const failingRun = vi.fn().mockRejectedValue(new Error('step failure'))
      const graph = build(l =>
        l.start()
         .step('boom', { run: failingRun, route: () => 'done' })
         .on('done').end()
      )
      const state: Record<string, unknown> = { existing: 'value' }
      const ctx = { sessionId: 'test-session' }

      // act / assert
      await expect(runLoop(graph, state, ctx, undefined)).rejects.toThrow('step failure')
      expect(state.existing).toBe('value')
    })

  })

})
