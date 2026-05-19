import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NoInterruptError, injectInterruptResponse } from './interrupt-resume.js'
import { createRunHandle, type RunOutcome } from './run-handle.js'
import { createAgent } from './create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import { runtime } from '../harness/ctx-markers.js'
import type { SessionStore, StoredRun } from './session-store.js'

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
// StoredRun fixture factory
// -----------------------------------------------------------------------

function makeStoredRun(overrides: Partial<StoredRun> & Pick<StoredRun, 'phase'>): StoredRun {
  return {
    agentId: 'test-agent',
    runId: 'default-run-id',
    sessionId: 'default-session-id',
    startedAt: '2026-01-01T00:00:00.000Z',
    settledAt: '2026-01-01T00:01:00.000Z',
    initialState: {},
    finalState: {},
    ...overrides,
  }
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
        agentId: 'test-agent',
        runId: 'r1',
        sessionId: 'sess-abc',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: {
          $interrupt: { interruptId: 'q1', prompt: 'Name?' },
          $interruptResponses: {},
          count: 5,
        },
      })
      store.save.mockResolvedValue(undefined)
      const sessionId = 'sess-abc'

      // act
      await injectInterruptResponse(store, 'test-agent', sessionId, 'q1', 'Alice')

      // assert
      expect(store.load).toHaveBeenCalledOnce()
      expect(store.load).toHaveBeenCalledWith('test-agent', 'sess-abc')
      expect(store.save).toHaveBeenCalledOnce()
      expect(store.save).toHaveBeenCalledWith('test-agent', 'sess-abc', expect.objectContaining({
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        finalState: {
          $interrupt: null,
          $interruptResponses: { q1: 'Alice' },
          count: 5,
        },
      }))
    })

    it('accumulates into existing $interruptResponses instead of overwriting', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        agentId: 'test-agent',
        runId: 'r1',
        sessionId: 'sess-abc',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: {
          $interrupt: { interruptId: 'q2', prompt: 'Age?' },
          $interruptResponses: { q1: 'existing' },
        },
      })
      store.save.mockResolvedValue(undefined)

      // act
      await injectInterruptResponse(store, 'test-agent', 'sess-abc', 'q2', 42)

      // assert
      expect(store.save).toHaveBeenCalledWith(
        'test-agent',
        'sess-abc',
        expect.objectContaining({
          finalState: { $interrupt: null, $interruptResponses: { q1: 'existing', q2: 42 } },
        }),
      )
    })

    it('omits signal field from saved session when original session has no signal', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        agentId: 'test-agent',
        runId: 'r1',
        sessionId: 'sess-abc',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        initialState: {},
        finalState: {
          $interrupt: { interruptId: 'q1', prompt: '?' },
          $interruptResponses: {},
        },
      })
      store.save.mockResolvedValue(undefined)

      // act
      await injectInterruptResponse(store, 'test-agent', 'sess-abc', 'q1', 'yes')

      // assert
      const saved = store.save.mock.calls[0]?.[2] as Record<string, unknown>
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
        injectInterruptResponse(store, 'test-agent', 'missing-session', 'q1', 'Alice'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when session phase is "completed"', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        agentId: 'test-agent',
        runId: 'r1',
        sessionId: 'sess-abc',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'completed',
        initialState: {},
        finalState: { $interrupt: null, $interruptResponses: {} },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'test-agent', 'sess-abc', 'q1', 'Alice'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when session is paused but $interrupt is null', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        agentId: 'test-agent',
        runId: 'r1',
        sessionId: 'sess-abc',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: { $interrupt: null, $interruptResponses: { q1: 'Alice' } },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'test-agent', 'sess-abc', 'q1', 'Bob'),
      ).rejects.toThrow(NoInterruptError)
      expect(store.save).not.toHaveBeenCalled()
    })

    it('rejects with NoInterruptError when interruptId does not match pending interrupt', async () => {
      // arrange
      const store = makeStubStore()
      store.load.mockResolvedValue({
        agentId: 'test-agent',
        runId: 'r1',
        sessionId: 'sess-abc',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
      })
      store.save.mockResolvedValue(undefined)

      // act & assert
      await expect(
        injectInterruptResponse(store, 'test-agent', 'sess-abc', 'q2', 'Alice'),
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
    const run = createRunHandle('sess-1', 'run-1', execution, stopFlag, stepRef, resumeFn)
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
    const run = createRunHandle('sess-2', 'run-2', execution, stopFlag, stepRef, resumeFn)
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
    const run = createRunHandle('sess-3', 'run-3', execution, { stopped: false }, { current: null }, resumeFn)

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
    const run = createRunHandle('sess-4', 'run-4', execution, { stopped: false }, { current: null }, resumeFn)
    await run

    // act & assert
    expect(() => run.resume('answer', 'q1')).toThrow(NoInterruptError)
  })

  it('throws NoInterruptError synchronously when execution settled with signal "done"', async () => {
    // arrange
    const execution = Promise.resolve({ state: { result: 42 }, signal: 'done' } as RunOutcome)
    const resumeFn = vi.fn()
    const run = createRunHandle('sess-5', 'run-5', execution, { stopped: false }, { current: null }, resumeFn)
    await run

    // act & assert
    expect(() => run.resume('answer', 'q1')).toThrow(NoInterruptError)
  })

  it('throws NoInterruptError when no resumeFn provided even if settled with $interrupt signal', async () => {
    // arrange
    const execution = Promise.resolve({ state: {}, signal: '$interrupt' } as RunOutcome)
    const run = createRunHandle('sess-6', 'run-6', execution, { stopped: false }, { current: null }) // 5 args, no resumeFn
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
    const run = createRunHandle('sess-7', 'run-7', execution, { stopped: false }, { current: null }, resumeFn)
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

    const agent = createAgent('test-agent', h, {})

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
    const agent = createAgent('test-agent', h, {})

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
        runId: 'r1',
        sessionId: 'sess-sync',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
      })
      .mockResolvedValueOnce({
        runId: 'r1',
        sessionId: 'sess-sync',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: { $interrupt: null, $interruptResponses: { q1: 'Alice' } },
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
    const agent = createAgent('test-agent', h, {})

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
      runId: 'r1',
      sessionId: 'sess-twoload',
      startedAt: '2026-01-01T00:00:00Z',
      settledAt: '2026-01-01T00:01:00Z',
      phase: 'paused' as const,
      step: 'ask',
      signal: '$interrupt',
      initialState: {},
      finalState: {
        $interrupt: { interruptId: 'q1', prompt: 'Name?' },
        $interruptResponses: {},
        name: null,
      },
    }
    store.load.mockResolvedValueOnce(pausedSession)
    store.load.mockResolvedValueOnce({
      ...pausedSession,
      finalState: { $interrupt: null, $interruptResponses: { q1: 'Alice' }, name: null },
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
    const agent = createAgent('test-agent', h, {})

    // act
    const result = await agent.resume('Alice', 'sess-twoload', 'q1')

    // assert
    expect(store.load).toHaveBeenCalledTimes(2)
    expect(store.load).toHaveBeenNthCalledWith(1, expect.any(String), 'sess-twoload')
    expect(store.load).toHaveBeenNthCalledWith(2, expect.any(String), 'sess-twoload')
    expect(store.save).toHaveBeenCalledWith(
      expect.any(String),
      'sess-twoload',
      expect.objectContaining({
        finalState: expect.objectContaining({
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
        runId: 'r1',
        sessionId: 'sess-chain',
        startedAt: '2026-01-01T00:00:00Z',
        settledAt: '2026-01-01T00:01:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: {
          $interrupt: { interruptId: '$auto:0', prompt: 'First?' },
          $interruptResponses: {},
        },
      })
      .mockResolvedValueOnce({
        runId: 'r2',
        sessionId: 'sess-chain',
        startedAt: '2026-01-01T00:02:00Z',
        settledAt: '2026-01-01T00:03:00Z',
        phase: 'paused',
        step: 'ask',
        signal: '$interrupt',
        initialState: {},
        finalState: {
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
    const agent = createAgent('test-agent', h, {})

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
      runId: 'r1',
      sessionId: 'sess-ctx',
      startedAt: '2026-01-01T00:00:00.000Z',
      settledAt: '2026-01-01T00:01:00.000Z',
      phase: 'paused',
      step: 'check',
      signal: '$interrupt',
      initialState: {},
      finalState: { $interrupt: { interruptId: 'q1', prompt: '?' }, $interruptResponses: {} },
    })
    store.load.mockResolvedValueOnce({
      runId: 'r2',
      sessionId: 'sess-ctx',
      startedAt: '2026-01-01T00:02:00.000Z',
      settledAt: '2026-01-01T00:03:00.000Z',
      phase: 'paused',
      step: 'check',
      signal: '$interrupt',
      initialState: {},
      finalState: { $interrupt: null, $interruptResponses: { q1: 'response' } },
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
    const agent = createAgent('test-agent', h, {})

    // act
    await agent.resume('response', 'sess-ctx', 'q1')

    // assert
    expect(capturedCtxKeys).toContain('sessionId')
    expect(capturedCtxKeys).not.toContain('runtimeVal')
  })
})

// -----------------------------------------------------------------------
// Group 10: injectInterruptResponse — error cases (F_RH)
// -----------------------------------------------------------------------

describe('injectInterruptResponse — error cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws NoInterruptError when store.load returns null', async () => {
    // arrange
    const store = makeStubStore()
    store.load.mockResolvedValue(null)

    // act & assert
    await expect(injectInterruptResponse(store, 'test-agent', 'sid-missing', 'iid-1', 'response')).rejects.toThrow(NoInterruptError)
  })

  it('throws NoInterruptError when loaded StoredRun has phase "completed"', async () => {
    // arrange
    const completedRun = makeStoredRun({ phase: 'completed' })
    const store = makeStubStore()
    store.load.mockResolvedValue(completedRun)

    // act & assert
    await expect(injectInterruptResponse(store, 'test-agent', 'sid-done', 'iid-1', 'response')).rejects.toThrow(NoInterruptError)
  })

  it('throws NoInterruptError when finalState.$interrupt is null', async () => {
    // arrange
    const pausedRun = makeStoredRun({ phase: 'paused', finalState: { $interrupt: null }, step: 'stepA' })
    const store = makeStubStore()
    store.load.mockResolvedValue(pausedRun)

    // act & assert
    await expect(injectInterruptResponse(store, 'test-agent', 'sid-no-interrupt', 'iid-1', 'response')).rejects.toThrow(NoInterruptError)
  })

  it('throws NoInterruptError when $interrupt.interruptId does not match the provided interruptId', async () => {
    // arrange
    const pausedRun = makeStoredRun({
      phase: 'paused',
      finalState: { $interrupt: { interruptId: 'iid-actual', prompt: 'what?' } },
      step: 'stepA',
    })
    const store = makeStubStore()
    store.load.mockResolvedValue(pausedRun)

    // act & assert
    await expect(injectInterruptResponse(store, 'test-agent', 'sid-mismatch', 'iid-wrong', 'response')).rejects.toThrow(NoInterruptError)
  })
})

// -----------------------------------------------------------------------
// Group 11: injectInterruptResponse — successful injection (F_RH)
// -----------------------------------------------------------------------

describe('injectInterruptResponse — successful injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves updated StoredRun with $interrupt null and $interruptResponses[interruptId] = response', async () => {
    // arrange
    const pausedRun = makeStoredRun({
      phase: 'paused',
      finalState: {
        x: 1,
        $interrupt: { interruptId: 'iid-42', prompt: 'pick a color' },
      },
      step: 'stepA',
    })
    const store = makeStubStore()
    store.load.mockResolvedValue(pausedRun)
    store.save.mockResolvedValue(undefined)

    // act
    await injectInterruptResponse(store, 'test-agent', pausedRun.sessionId, 'iid-42', 'blue')

    // assert
    expect(store.save).toHaveBeenCalledOnce()
    const saved = store.save.mock.calls[0]![2] as Record<string, unknown>
    const finalState = saved['finalState'] as Record<string, unknown>
    expect(finalState['$interrupt']).toBeNull()
    expect((finalState['$interruptResponses'] as Record<string, unknown>)['iid-42']).toBe('blue')
    expect(finalState['x']).toBe(1)
  })

  it('preserves identity fields from loaded record unchanged in saved record', async () => {
    // arrange
    const pausedRun: StoredRun = {
      agentId: 'test-agent',
      runId: 'run-preserve-me',
      sessionId: 'sid-preserve-me',
      startedAt: '2026-01-01T00:00:00.000Z',
      settledAt: '2026-01-01T00:05:00.000Z',
      phase: 'paused',
      initialState: { a: 100 },
      finalState: { a: 100, $interrupt: { interruptId: 'iid-99', prompt: 'q' } },
      step: 'stepZ',
      signal: '$interrupt',
    }
    const store = makeStubStore()
    store.load.mockResolvedValue(pausedRun)
    store.save.mockResolvedValue(undefined)

    // act
    await injectInterruptResponse(store, 'test-agent', 'sid-preserve-me', 'iid-99', 42)

    // assert
    const saved = store.save.mock.calls[0]![2] as StoredRun
    expect(saved.runId).toBe('run-preserve-me')
    expect(saved.sessionId).toBe('sid-preserve-me')
    expect(saved.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(saved.settledAt).toBe('2026-01-01T00:05:00.000Z')
    expect(saved.initialState).toEqual({ a: 100 })
    expect(saved.step).toBe('stepZ')
    expect(saved.signal).toBe('$interrupt')
  })
})

