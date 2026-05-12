import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NoInterruptError, injectInterruptResponse } from './interrupt-resume.js'
import { createRunHandle, type RunOutcome } from './run-handle.js'
import { createAgent } from './create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import { runtime } from '../harness/ctx-markers.js'
import type { SessionStore } from './session-store.js'
import * as publicApi from '../index.js'

// -----------------------------------------------------------------------
// Stub factory helpers
// -----------------------------------------------------------------------

function makeStubStore(): SessionStore & { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(),
    save: vi.fn(),
  } as unknown as SessionStore & { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> }
}

// -----------------------------------------------------------------------
// Group 1: NoInterruptError class
// -----------------------------------------------------------------------

describe('NoInterruptError', () => {
  describe('Group 1: class shape', () => {
    it('name equals "NoInterruptError" when constructed', () => {
      // act
      const err = new NoInterruptError()

      // assert
      expect(err.name).toBe('NoInterruptError')
      expect(err).toBeInstanceOf(NoInterruptError)
      expect(err).toBeInstanceOf(Error)
    })

    it('message is non-empty and mentions resume() and interrupt', () => {
      // act
      const err = new NoInterruptError()

      // assert
      expect(err.message.length).toBeGreaterThan(0)
      expect(err.message).toMatch(/resume\(\)/)
      expect(err.message).toMatch(/interrupt/i)
    })
  })
})

// -----------------------------------------------------------------------
// Group 2: injectInterruptResponse — success path
// -----------------------------------------------------------------------

describe('injectInterruptResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Group 2: success path', () => {
    it('saves session with $interrupt null and response injected when session is interrupt-paused', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: {
          $interrupt: { interruptId: 'q1', prompt: 'Name?' },
          $interruptResponses: {},
          count: 5,
        },
      })
      store.save.mockResolvedValue(undefined)
      const sessionId = 'sess-abc'

      // act
      await injectInterruptResponse(store, sessionId, 'q1', 'Alice')

      // assert
      expect(store.load).toHaveBeenCalledOnce()
      expect(store.load).toHaveBeenCalledWith('sess-abc')
      expect(store.save).toHaveBeenCalledOnce()
      expect(store.save).toHaveBeenCalledWith('sess-abc', {
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: {
          $interrupt: null,
          $interruptResponses: { q1: 'Alice' },
          count: 5,
        },
      })
    })

    it('accumulates into existing $interruptResponses instead of overwriting', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: {
          $interrupt: { interruptId: 'q2', prompt: 'Age?' },
          $interruptResponses: { q1: 'existing' },
        },
      })
      store.save.mockResolvedValue(undefined)

      // act
      await injectInterruptResponse(store, 'sess-abc', 'q2', 42)

      // assert
      expect(store.save).toHaveBeenCalledWith(
        'sess-abc',
        expect.objectContaining({
          state: { $interrupt: null, $interruptResponses: { q1: 'existing', q2: 42 } },
        }),
      )
    })

    it('omits signal field from saved session when original session has no signal', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'paused',
        step: 'ask',
        state: {
          $interrupt: { interruptId: 'q1', prompt: '?' },
          $interruptResponses: {},
        },
      })
      store.save.mockResolvedValue(undefined)

      // act
      await injectInterruptResponse(store, 'sess-abc', 'q1', 'yes')

      // assert
      const saved = store.save.mock.calls[0]?.[1] as Record<string, unknown>
      expect('signal' in saved).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Group 3: injectInterruptResponse — error paths
  // -----------------------------------------------------------------------

  describe('Group 3: error paths', () => {
    it('rejects with NoInterruptError when store.load returns null (no session)', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue(null)
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'missing-session', 'q1', 'Alice'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when session phase is "in-flight"', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'in-flight',
        step: 'ask',
        state: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'sess-abc', 'q1', 'Alice'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when session phase is "completed"', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'completed',
        step: null,
        state: { $interrupt: null, $interruptResponses: {} },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'sess-abc', 'q1', 'Alice'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when session is paused but $interrupt is null', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: { $interrupt: null, $interruptResponses: { q1: 'Alice' } },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'sess-abc', 'q1', 'Bob'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when interruptId does not match pending interrupt', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'sess-abc', 'q2', 'Alice'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })
  })
})

// -----------------------------------------------------------------------
// Group 4: createRunHandle — settled outcome caching
// -----------------------------------------------------------------------

describe('createRunHandle settled outcome caching', () => {
  it('settledOutcome is captured so run.resume() succeeds after execution resolves with $interrupt', async () => {
    // arrange
    const resumeFnResult = {} as ReturnType<typeof createRunHandle>
    const resumeFn = vi.fn().mockReturnValue(resumeFnResult)
    const outcome: RunOutcome = { state: { name: 'Alice' }, signal: '$interrupt' }
    const execution = Promise.resolve(outcome)
    const stopFlag = { stopped: false }
    const stepRef: { current: string | null } = { current: 'ask' }
    const run = createRunHandle('sess-1', execution, stopFlag, stepRef, resumeFn)
    await run

    // act
    const result = run.resume('Alice', 'q1')

    // assert
    expect(resumeFn).toHaveBeenCalledOnce()
    expect(resumeFn).toHaveBeenCalledWith('Alice', 'q1')
    expect(result).toBe(resumeFnResult)
    expect(run.currentStep).toBeNull()
  })

  it('stepRef.current is cleared to null and settledOutcome remains null after rejection', async () => {
    // arrange
    const resumeFn = vi.fn()
    const execution = Promise.reject(new Error('step failure'))
    const stopFlag = { stopped: false }
    const stepRef: { current: string | null } = { current: 'crash-step' }
    const run = createRunHandle('sess-2', execution, stopFlag, stepRef, resumeFn)
    try { await run } catch { /* suppress */ }

    // act
    const callResume = () => run.resume('answer', 'q1')

    // assert
    expect(run.currentStep).toBeNull()
    expect(callResume).toThrow(NoInterruptError)
  })
})

// -----------------------------------------------------------------------
// Group 5: run.resume() — synchronous guard conditions
// -----------------------------------------------------------------------

describe('run.resume() guard conditions', () => {
  it('throws NoInterruptError synchronously when execution has not yet settled', () => {
    // arrange
    let resolveExecution!: (v: RunOutcome) => void
    const execution = new Promise<RunOutcome>(r => { resolveExecution = r })
    const resumeFn = vi.fn()
    const run = createRunHandle('sess-3', execution, { stopped: false }, { current: null }, resumeFn)

    // act
    const callResume = () => run.resume('answer', 'q1')

    // assert
    expect(callResume).toThrow(NoInterruptError)

    // cleanup
    resolveExecution({ state: {}, signal: 'done' })
  })

  it('throws NoInterruptError synchronously when execution settled with signal null (graceful stop)', async () => {
    // arrange
    const execution = Promise.resolve({ state: {}, signal: null } as RunOutcome)
    const resumeFn = vi.fn()
    const run = createRunHandle('sess-4', execution, { stopped: false }, { current: null }, resumeFn)
    await run

    // act & assert
    expect(() => run.resume('answer', 'q1')).toThrow(NoInterruptError)
  })

  it('throws NoInterruptError synchronously when execution settled with signal "done"', async () => {
    // arrange
    const execution = Promise.resolve({ state: { result: 42 }, signal: 'done' } as RunOutcome)
    const resumeFn = vi.fn()
    const run = createRunHandle('sess-5', execution, { stopped: false }, { current: null }, resumeFn)
    await run

    // act & assert
    expect(() => run.resume('answer', 'q1')).toThrow(NoInterruptError)
  })

  it('throws NoInterruptError when no resumeFn provided even if settled with $interrupt signal', async () => {
    // arrange
    const execution = Promise.resolve({ state: {}, signal: '$interrupt' } as RunOutcome)
    const run = createRunHandle('sess-6', execution, { stopped: false }, { current: null }) // 4 args, no resumeFn
    await run

    // act & assert
    expect(() => run.resume('answer', 'q1')).toThrow(NoInterruptError)
  })
})

// -----------------------------------------------------------------------
// Group 6: run.resume() — success and chaining
// -----------------------------------------------------------------------

describe('run.resume() success and chaining', () => {
  it('calls resumeFn with response and interruptId and returns its RunHandle', async () => {
    // arrange
    const innerHandle = {
      then: vi.fn(),
      stop: vi.fn(),
      resume: vi.fn(),
      sessionId: 'sess-7',
      currentStep: null,
    } as unknown as ReturnType<typeof createRunHandle>
    const resumeFn = vi.fn().mockReturnValue(innerHandle)
    const execution = Promise.resolve({ state: { name: 'Alice' }, signal: '$interrupt' } as RunOutcome)
    const run = createRunHandle('sess-7', execution, { stopped: false }, { current: null }, resumeFn)
    await run

    // act
    const result = run.resume('Bob', 'ask-name')

    // assert
    expect(resumeFn).toHaveBeenCalledOnce()
    expect(resumeFn).toHaveBeenCalledWith('Bob', 'ask-name')
    expect(result).toBe(innerHandle)
  })

  it('returned handle from run.resume() supports further resume() calls (chained interrupts)', async () => {
    // arrange
    const sessionId = 'sess-chain'
    type Ctx = Record<string, never>

    const h = createHarness<Ctx>()({}).loop((l) => {
      l.start().step('step1', {
        run: async (_state, ctx) => {
          const r1 = await (ctx as unknown as { interrupt: (p: string) => Promise<unknown> }).interrupt('First?')
          const r2 = await (ctx as unknown as { interrupt: (p: string) => Promise<unknown> }).interrupt('Second?')
          return { results: [r1, r2] }
        },
        route: () => 'done',
      }).on('done').end()
    })

    const agent = createAgent(h, {})

    // First run — will pause at $auto:0
    const run1 = agent.run({}, { sessionId })
    const outcome1 = await run1

    // act
    const run2 = run1.resume('ans1', '$auto:0')
    const outcome2 = await run2
    const run3 = run2.resume('ans2', '$auto:1')
    const outcome3 = await run3

    // assert
    expect(outcome1.signal).toBe('$interrupt')
    expect(outcome2.signal).toBe('$interrupt')
    expect(outcome3.signal).toBe('done')
    expect(outcome3.state).toMatchObject({ results: ['ans1', 'ans2'] })
  })
})

// -----------------------------------------------------------------------
// Group 7: agent.resume() — missing store guard
// -----------------------------------------------------------------------

describe('agent.resume() missing store guard', () => {
  it('execution rejects with NoInterruptError when agent has no store', async () => {
    // arrange
    const h = createHarness<Record<string, never>>()({}).loop(
      (l) => {
        l.start().step('noop', { run: async () => ({}), route: () => 'done' }).on('done').end()
      },
    )
    const agent = createAgent(h, {})

    // act
    const handle = agent.resume('response', 'any-session', 'any-id')

    // assert
    expect(typeof handle.then).toBe('function')
    await expect(handle).rejects.toThrow(NoInterruptError)
  })
})

// -----------------------------------------------------------------------
// Group 8: agent.resume() — success path and two-load ordering
// -----------------------------------------------------------------------

describe('agent.resume() success path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns RunHandle synchronously before any async work begins', async () => {
    // arrange
    const stepCallCount = { n: 0 }
    const store = makeStubStore()
    store.load
      .mockResolvedValueOnce({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
      })
      .mockResolvedValueOnce({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: { $interrupt: null, $interruptResponses: { q1: 'Alice' } },
      })
    store.save.mockResolvedValue(undefined)

    const h = createHarness<Record<string, never>>()({})
      .store({ session: store })
      .loop((l) => {
        l.start().step('ask', {
          run: async (_state, ctx) => {
            stepCallCount.n++
            await (ctx as unknown as { interrupt: (p: string, id: string) => Promise<unknown> }).interrupt('?', 'q1')
            return {}
          },
          route: () => 'done',
        }).on('done').end()
      })
    const agent = createAgent(h, {})

    // act
    const handle = agent.resume('Alice', 'sess-sync', 'q1')
    const stepCountBeforeAnyTick = stepCallCount.n

    // assert
    expect(typeof handle.then).toBe('function')
    expect(typeof handle.stop).toBe('function')
    expect(typeof handle.sessionId).toBe('string')
    expect(stepCountBeforeAnyTick).toBe(0)

    // settle to avoid leak
    try { await handle } catch { /* ignore */ }
  })

  it('calls injectInterruptResponse before runWithSession; two sequential store loads', async () => {
    // arrange
    const store = makeStubStore()

    const pausedSession = {
      phase: 'paused' as const,
      step: 'ask',
      signal: '$interrupt',
      state: {
        $interrupt: { interruptId: 'q1', prompt: 'Name?' },
        $interruptResponses: {},
        name: null,
      },
    }
    store.load.mockResolvedValueOnce(pausedSession)
    store.load.mockResolvedValueOnce({
      ...pausedSession,
      state: { $interrupt: null, $interruptResponses: { q1: 'Alice' }, name: null },
    })
    store.save.mockResolvedValue(undefined)

    const h = createHarness<Record<string, never>>()({})
      .store({ session: store })
      .loop((l) => {
        l.start().step('ask', {
          run: async (_state, ctx) => {
            const name = await (ctx as unknown as { interrupt: (p: string, id: string) => Promise<unknown> }).interrupt('Name?', 'q1')
            return { name }
          },
          route: () => 'done',
        }).on('done').end()
      })
    const agent = createAgent(h, {})

    // act
    const result = await agent.resume('Alice', 'sess-twoload', 'q1')

    // assert
    expect(store.load).toHaveBeenCalledTimes(2)
    expect(store.load).toHaveBeenNthCalledWith(1, 'sess-twoload')
    expect(store.load).toHaveBeenNthCalledWith(2, 'sess-twoload')
    expect(store.save).toHaveBeenCalledWith(
      'sess-twoload',
      expect.objectContaining({
        state: expect.objectContaining({
          $interrupt: null,
          $interruptResponses: { q1: 'Alice' },
        }),
      }),
    )
    expect(result.signal).toBe('done')
    expect(result.state).toMatchObject({ name: 'Alice' })
  })

  it('resumed handle settles with $interrupt when step pauses again; further resume() works', async () => {
    // arrange
    const store = makeStubStore()
    store.load
      .mockResolvedValueOnce({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: {
          $interrupt: { interruptId: '$auto:0', prompt: 'First?' },
          $interruptResponses: {},
        },
      })
      .mockResolvedValueOnce({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        state: {
          $interrupt: { interruptId: '$auto:1', prompt: 'Second?' },
          $interruptResponses: { '$auto:0': 'A' },
        },
      })
      .mockResolvedValue(null) // fallback: any further loads return null (NoInterruptError, not TypeError)
    store.save.mockResolvedValue(undefined)

    const h = createHarness<Record<string, never>>()({})
      .store({ session: store })
      .loop((l) => {
        l.start().step('ask', {
          run: async (_state, ctx) => {
            const first = await (ctx as unknown as { interrupt: (p: string) => Promise<unknown> }).interrupt('First?')
            const second = await (ctx as unknown as { interrupt: (p: string) => Promise<unknown> }).interrupt('Second?')
            return { first, second }
          },
          route: () => 'done',
        }).on('done').end()
      })
    const agent = createAgent(h, {})

    // act
    const handle1 = agent.resume('A', 'sess-chain', '$auto:0')
    const outcome1 = await handle1

    // assert
    expect(outcome1.signal).toBe('$interrupt')
    const handle2 = handle1.resume('B', '$auto:1')
    expect(typeof handle2.then).toBe('function')

    // settle handle2 to avoid unhandled rejection (async execution fires 3rd store.load → null → NoInterruptError)
    await handle2.then(null, () => { /* expected rejection */ })
  })
})

// -----------------------------------------------------------------------
// Group 9: agent.resume() — ctx isolation
// -----------------------------------------------------------------------

describe('agent.resume() ctx isolation', () => {
  it('resumed ctx does not include runtime slot keys; only resolvedProviders and sessionId', async () => {
    // arrange
    const capturedCtxKeys: string[] = []

    const store = makeStubStore()
    store.load.mockResolvedValueOnce({
      phase: 'paused',
      step: 'check',
      signal: '$interrupt',
      state: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
    })
    store.load.mockResolvedValueOnce({
      phase: 'paused',
      step: 'check',
      signal: '$interrupt',
      state: { $interrupt: null, $interruptResponses: { q1: 'response' } },
    })
    store.save.mockResolvedValue(undefined)

    const h = createHarness<{ runtimeVal: string }>()({})
      .provide('runtimeVal', runtime())
      .store({ session: store })
      .loop((l) => {
        l.start().step('check', {
          run: async (_state, ctx) => {
            capturedCtxKeys.push(...Object.keys(ctx as object))
            return {}
          },
          route: () => 'done',
        }).on('done').end()
      })
    const agent = createAgent(h, {})

    // act
    await agent.resume('response', 'sess-ctx', 'q1')

    // assert
    expect(capturedCtxKeys).toContain('sessionId')
    expect(capturedCtxKeys).not.toContain('runtimeVal')
  })
})

// -----------------------------------------------------------------------
// Group 10: Public API export
// -----------------------------------------------------------------------

describe('Public API export', () => {
  it('NoInterruptError is exported from the public index', () => {
    // act
    // (imported at top of file)

    // assert
    expect(publicApi.NoInterruptError).toBeDefined()
    expect(new publicApi.NoInterruptError()).toBeInstanceOf(Error)
    expect(new publicApi.NoInterruptError().name).toBe('NoInterruptError')
  })
})
