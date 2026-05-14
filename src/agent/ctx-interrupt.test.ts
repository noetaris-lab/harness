import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createInterruptFn, InterruptPause } from './ctx-interrupt.js'
import { runLoop } from '../loop/loop-executor.js'
import { runWithSession } from './session-lifecycle.js'
import { createLoopBuilder, extractLoopDefinition } from '../loop/loop-dsl.js'
import type { SessionStore } from './session-store.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'

// -----------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------

function build(
  fn: (l: ReturnType<typeof createLoopBuilder<
    Record<string, unknown>,
    Record<string, unknown> & { sessionId: string }
  >>) => void
): LoopDefinition {
  const builder = createLoopBuilder<
    Record<string, unknown>,
    Record<string, unknown> & { sessionId: string }
  >()
  fn(builder)
  return extractLoopDefinition(builder as Parameters<typeof extractLoopDefinition>[0])
}

function makeStubStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('createInterruptFn', () => {

  describe('replay path', () => {

    it('returns stored response when explicit id is present in $interruptResponses', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: { 'ask-name': 'Alice' } }
      const callCountRef = { current: 0 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act
      const result = await interruptFn('What is your name?', 'ask-name')

      // assert
      expect(result).toBe('Alice')
      expect(state.$interrupt).toBeUndefined()
      expect(callCountRef.current).toBe(0)
    })

    it('returns stored response for auto id and increments counter', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: { '$auto:0': 'yes' } }
      const callCountRef = { current: 0 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act
      const result = await interruptFn('Confirm?')

      // assert
      expect(result).toBe('yes')
      expect(callCountRef.current).toBe(1)
    })

    it('both calls return stored responses when all responses are present', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: { '$auto:0': 'foo', '$auto:1': 'bar' } }
      const callCountRef = { current: 0 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act
      const r1 = await interruptFn('Q1?')
      const r2 = await interruptFn('Q2?')

      // assert
      expect(r1).toBe('foo')
      expect(r2).toBe('bar')
      expect(callCountRef.current).toBe(2)
      expect(state.$interrupt).toBeUndefined()
    })

    it('explicit id does not increment counter', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: {} }
      const callCountRef = { current: 0 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act
      const promise = interruptFn('Q?', 'my-id')

      // assert
      expect(callCountRef.current).toBe(0)
      await expect(promise).rejects.toThrow(InterruptPause)
    })

  })

  describe('pause path', () => {

    it('throws InterruptPause and sets $interrupt for explicit id', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: {} }
      const callCountRef = { current: 0 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act + assert
      await expect(interruptFn('What is your name?', 'ask-name')).rejects.toThrow(InterruptPause)
      expect(state.$interrupt).toEqual({ interruptId: 'ask-name', prompt: 'What is your name?' })

      let thrown: unknown
      try { await interruptFn('What is your name?', 'ask-name') } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(InterruptPause)
      expect((thrown as InterruptPause).interruptId).toBe('ask-name')
      expect((thrown as InterruptPause).prompt).toBe('What is your name?')
    })

    it('uses $auto:N id and increments counter on pause', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: {} }
      const callCountRef = { current: 2 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act
      let thrown: unknown
      try { await interruptFn('Continue?') } catch (e) { thrown = e }

      // assert
      expect(thrown).toBeInstanceOf(InterruptPause)
      expect((thrown as InterruptPause).interruptId).toBe('$auto:2')
      expect((thrown as InterruptPause).prompt).toBe('Continue?')
      expect(state.$interrupt).toEqual({ interruptId: '$auto:2', prompt: 'Continue?' })
      expect(callCountRef.current).toBe(3)
    })

    it('first call replays, second call pauses with next auto id', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: { '$auto:0': 'yes' } }
      const callCountRef = { current: 0 }
      const interruptFn = createInterruptFn(state, callCountRef)

      // act
      const r1 = await interruptFn('First?')
      expect(callCountRef.current).toBe(1)
      let thrown: unknown
      try { await interruptFn('Second?') } catch (e) { thrown = e }

      // assert
      expect(r1).toBe('yes')
      expect(thrown).toBeInstanceOf(InterruptPause)
      expect((thrown as InterruptPause).interruptId).toBe('$auto:1')
      expect((thrown as InterruptPause).prompt).toBe('Second?')
      expect(state.$interrupt).toEqual({ interruptId: '$auto:1', prompt: 'Second?' })
      expect(callCountRef.current).toBe(2)
    })

  })

})

describe('runLoop', () => {

  describe('$interruptResponses initialization', () => {

    it('initializes $interruptResponses to {} when the key is absent', async () => {
      // arrange
      const state: Record<string, unknown> = {}
      const graph = build(l => l.start().step('go', { run: async () => ({}), route: () => 'done' }).on('done').end())
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect('$interruptResponses' in state).toBe(true)
    })

    it('preserves existing $interruptResponses when already present', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: { '$auto:0': 'cached' } }
      let capturedReturn: unknown
      const graph = build(l => l.start()
        .step('go', {
          run: async (_s, ctx) => { capturedReturn = await ctx.interrupt('Q?'); return {} },
          route: () => 'done',
        })
        .on('done').end()
      )
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(capturedReturn).toBe('cached')
    })

  })

  describe('per-step counter reset', () => {

    it('counter resets to 0 before the second step\'s run', async () => {
      // arrange
      const state: Record<string, unknown> = {
        $interruptResponses: { '$auto:0': 'r1', '$auto:1': 'r2' }
      }
      const graph = build(l => l.start()
        .step('step1', {
          run: async (_s, ctx) => {
            await ctx.interrupt('Q1')
            await ctx.interrupt('Q2')
            return {}
          },
        })
        .next('step2')
        .step('step2', {
          run: async (_s, ctx) => {
            await ctx.interrupt('Q3')
            return {}
          },
          route: () => 'done',
        })
        .on('done').end()
      )
      const ctx = { sessionId: 'test' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('$interrupt')
      expect(result.cursor).toBe('step2')
      expect((state.$interrupt as Record<string, unknown>).interruptId).toBe('$auto:0')
    })

  })

  describe('InterruptPause catch and error re-throw', () => {

    it('catches InterruptPause and returns paused LoopResult', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: {} }
      const graph = build(l => l.start()
        .step('ask', {
          run: async (_s, ctx) => {
            await ctx.interrupt('What is your name?', 'ask-name')
            return {}
          },
          route: () => 'done',
        })
        .on('done').end()
      )
      const ctx = { sessionId: 'test' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert
      expect(result.signal).toBe('$interrupt')
      expect(result.cursor).toBe('ask')
      expect(result.paused).toBe(true)
      expect(state.$interrupt).toEqual({ interruptId: 'ask-name', prompt: 'What is your name?' })
    })

    it('routes non-InterruptPause errors via $error; does not rethrow', async () => {
      // arrange
      const graph = build(l => l.start()
        .step('broken', {
          optin: '$error',
          run: async () => { throw new TypeError('bad input') },
          route: (s) => (s as any).$error !== null ? 'abort' : 'done',
        })
        .on('abort').end()
        .on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { sessionId: 'test' }

      // act
      const result = await runLoop(graph, state, ctx, undefined)

      // assert — F10: non-interrupt errors are routed via $error, not re-thrown
      expect(result.signal).toBe('abort')
      expect(result.paused).toBe(false)
      expect(result.state.$error).toBeInstanceOf(TypeError)
    })

  })

  describe('interrupt state cleared after step completion', () => {

    it('clears $interrupt and $interruptResponses after successful step run', async () => {
      // arrange
      const state: Record<string, unknown> = {
        $interrupt: { interruptId: 'x', prompt: 'p' },
        $interruptResponses: { 'x': 'r' },
      }
      const graph = build(l => l.start()
        .step('go', {
          run: async () => ({ result: 'done' }),
          route: () => 'done',
        })
        .on('done').end()
      )
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$interrupt).toBeNull()
      expect(state.$interruptResponses).toEqual({})
    })

    it('decision node with no run function does not clear interrupt state', async () => {
      // arrange
      const state: Record<string, unknown> = {
        $interrupt: { interruptId: 'y', prompt: 'q' },
        $interruptResponses: { 'y': 'ans' },
      }
      const graph = build(l => l.start()
        .step('decide', { route: () => 'done' })
        .on('done').end()
      )
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(state.$interrupt).toEqual({ interruptId: 'y', prompt: 'q' })
      expect(state.$interruptResponses).toEqual({ 'y': 'ans' })
    })

  })

  describe('applyUpdate strips $interruptResponses and startCursor routing', () => {

    it('$interruptResponses is silently dropped from step return value', async () => {
      // arrange
      const state: Record<string, unknown> = { $interruptResponses: { 'real': 'keeper' } }
      const graph = build(l => l.start()
        .step('go', {
          run: async () => ({ $interruptResponses: { hacked: 'value' } } as unknown as Record<string, unknown>),
          route: () => 'done',
        })
        .on('done').end()
      )
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect((state.$interruptResponses as Record<string, unknown>)['hacked']).toBeUndefined()
    })

    it('starts from startCursor step instead of entryStep when startCursor is provided', async () => {
      // arrange
      const initRun = vi.fn().mockResolvedValue({})
      const graph = build(l => l.start()
        .step('init', { run: initRun }).next('process')
        .step('process', { route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined, undefined, 'process')

      // assert
      expect(initRun).not.toHaveBeenCalled()
    })

    it('starts from graph.entryStep when startCursor is omitted', async () => {
      // arrange
      const initRun = vi.fn().mockResolvedValue({})
      const graph = build(l => l.start()
        .step('init', { run: initRun, route: () => 'done' }).on('done').end()
      )
      const state: Record<string, unknown> = {}
      const ctx = { sessionId: 'test' }

      // act
      await runLoop(graph, state, ctx, undefined)

      // assert
      expect(initRun).toHaveBeenCalledOnce()
    })

  })

})

describe('runWithSession', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('cursor threading', () => {

    it('passes loaded session step as startCursor to runLoop', async () => {
      // arrange
      const initRun = vi.fn().mockResolvedValue({})
      const processRun = vi.fn().mockResolvedValue({})
      const graph = build(l => l.start()
        .step('init', { run: initRun }).next('process')
        .step('process', { run: processRun, route: () => 'done' }).on('done').end()
      )
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({ phase: 'paused', state: {}, step: 'process' })
      })
      const ctx = { sessionId: 'sess-1' }

      // act
      await runWithSession(store, 'sess-1', graph, {}, undefined, ctx)

      // assert
      expect(initRun).not.toHaveBeenCalled()
      expect(processRun).toHaveBeenCalledOnce()
    })

    it('omits startCursor and starts from entryStep when store is undefined', async () => {
      // arrange
      const initRun = vi.fn().mockResolvedValue({})
      const graph = build(l => l.start()
        .step('init', { run: initRun, route: () => 'done' }).on('done').end()
      )
      const ctx = { sessionId: 'no-store-sess' }

      // act
      await runWithSession(undefined, 'no-store-sess', graph, {}, undefined, ctx)

      // assert
      expect(initRun).toHaveBeenCalledOnce()
    })

    it('uses graph.entryStep when loaded session has no step field', async () => {
      // arrange
      const initRun = vi.fn().mockResolvedValue({})
      const graph = build(l => l.start()
        .step('init', { run: initRun, route: () => 'done' }).on('done').end()
      )
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({ phase: 'paused', state: {} })
      })
      const ctx = { sessionId: 'sess-2' }

      // act
      await runWithSession(store, 'sess-2', graph, {}, undefined, ctx)

      // assert
      expect(initRun).toHaveBeenCalledOnce()
    })

  })

})
