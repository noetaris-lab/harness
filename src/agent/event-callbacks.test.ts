import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgent } from './create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import type { SessionStore } from './session-store.js'

// -----------------------------------------------------------------------
// Type placeholder — tests use plain Record<string, unknown> ctx
// -----------------------------------------------------------------------

type Ctx = Record<string, unknown>

// -----------------------------------------------------------------------
// makeStubStore — minimal SessionStore stub
// -----------------------------------------------------------------------

function makeStubStore(overrides: Partial<{ load: SessionStore['load']; save: SessionStore['save'] }> = {}): SessionStore {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// describe block
// -----------------------------------------------------------------------

describe('EventCallbacks', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Group 1: onBeforeStep firing
  // -----------------------------------------------------------------------

  describe('onBeforeStep firing', () => {

    it('fires onBeforeStep with pre-run state snapshot before a step with run', async () => {
      // arrange
      const capturedStates: Array<Record<string, unknown>> = []
      const onBeforeStep = vi.fn().mockImplementation((_name: string, s: Record<string, unknown>) => { capturedStates.push({ ...s }) })
      const runFn = vi.fn().mockResolvedValue({ count: 99 })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})
      const initialState = { count: 0 }

      // act
      const run = agent.run(initialState, { events: { onBeforeStep } })
      await run

      // assert
      expect(onBeforeStep).toHaveBeenCalledOnce()
      expect(onBeforeStep).toHaveBeenCalledWith('work', expect.objectContaining({ count: 0 }))
      expect(capturedStates[0]!.count).toBe(0)
    })

    it('fires onBeforeStep before a route-only decision node', async () => {
      // arrange
      const onBeforeStep = vi.fn()
      const runWorker = vi.fn().mockResolvedValue({})
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('check', { route: () => 'go' }).on('go').to('work').step('work', { run: runWorker, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onBeforeStep } })
      await run

      // assert
      expect(onBeforeStep).toHaveBeenCalledTimes(2)
      expect(onBeforeStep).toHaveBeenNthCalledWith(1, 'check', expect.any(Object))
    })

  })

  // -----------------------------------------------------------------------
  // Group 2: onAfterStep firing
  // -----------------------------------------------------------------------

  describe('onAfterStep firing', () => {

    it('fires onAfterStep with updated state after run completes successfully', async () => {
      // arrange
      const capturedState: Record<string, unknown>[] = []
      const onAfterStep = vi.fn().mockImplementation((_name: string, s: Record<string, unknown>) => { capturedState.push({ ...s }) })
      const runFn = vi.fn().mockResolvedValue({ result: 'done' })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('compute', { run: runFn, route: () => 'finish' }).on('finish').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onAfterStep } })
      await run

      // assert
      expect(onAfterStep).toHaveBeenCalledOnce()
      expect(onAfterStep).toHaveBeenCalledWith('compute', expect.objectContaining({ result: 'done' }))
      expect(capturedState[0]!.result).toBe('done')
    })

    it('does not fire onAfterStep when run throws', async () => {
      // arrange
      const onAfterStep = vi.fn()
      const runFn = vi.fn().mockRejectedValue(new Error('step blew up'))
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('boom', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onAfterStep } })
      const outcome = await run

      // assert
      expect(onAfterStep).not.toHaveBeenCalled()
      expect(outcome.signal).toBe('$error')
    })

  })

  // -----------------------------------------------------------------------
  // Group 3: onError firing
  // -----------------------------------------------------------------------

  describe('onError firing', () => {

    it('fires onError with the thrown error and step name when run throws a non-interrupt error', async () => {
      // arrange
      const thrownError = new Error('domain failure')
      const onError = vi.fn()
      const runFn = vi.fn().mockRejectedValue(thrownError)
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('risky', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onError } })
      await run

      // assert
      expect(onError).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledWith(thrownError, 'risky')
    })

    it('does NOT fire onError when run throws an interrupt exception', async () => {
      // arrange
      const onError = vi.fn()
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { await (ctx['interrupt'] as (p: unknown, id: string) => Promise<unknown>)('confirm?', 'i1'); return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('pause', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onError } })
      const outcome = await run

      // assert
      expect(onError).not.toHaveBeenCalled()
      expect(outcome.signal).toBe('$interrupt')
    })

    it('fires onError even when l.onError() step handles the error', async () => {
      // arrange
      const onError = vi.fn()
      const runBad = vi.fn().mockRejectedValue(new Error('bad'))
      const runRecovery = vi.fn().mockResolvedValue({})
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('risky', { run: runBad }).step('recovery', { run: runRecovery, route: () => 'done' }).on('done').end().onError('recovery'))
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onError } })
      const outcome = await run

      // assert
      expect(onError).toHaveBeenCalledOnce()
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'risky')
      expect(outcome.signal).toBe('done')
    })

    it('fires onError before per-step route when route handles $error signal', async () => {
      // arrange
      const onError = vi.fn()
      const runFn = vi.fn().mockRejectedValue(new Error('step error'))
      // optin: '$error' makes route callable even when run throws (errorAware: true in LoopDefinition)
      const routeFn = vi.fn().mockImplementation((s: Record<string, unknown>) => s.$error ? '$error' : 'done')
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('errorAware', { optin: '$error', run: runFn, route: routeFn }).on('$error').end().on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onError } })
      await run

      // assert
      expect(onError).toHaveBeenCalledOnce()
      expect(routeFn).toHaveBeenCalledOnce()
      expect(onError.mock.invocationCallOrder[0]).toBeLessThan(routeFn.mock.invocationCallOrder[0]!)
    })

  })

  // -----------------------------------------------------------------------
  // Group 4: onComplete firing
  // -----------------------------------------------------------------------

  describe('onComplete firing', () => {

    it('fires onComplete with final state and exit signal on normal .on(signal).end() exit', async () => {
      // arrange
      const onComplete = vi.fn()
      const runFn = vi.fn().mockResolvedValue({ answer: 42 })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('final', { run: runFn, route: () => 'success' }).on('success').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onComplete } })
      await run

      // assert
      expect(onComplete).toHaveBeenCalledOnce()
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ answer: 42 }), 'success')
    })

    it('does not fire onComplete when run is stopped via AbortSignal', async () => {
      // arrange
      const onComplete = vi.fn()
      const controller = new AbortController()
      const runFn = vi.fn().mockResolvedValue({})
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})
      controller.abort()

      // act
      const run = agent.run({}, { events: { onComplete }, signal: controller.signal })
      const outcome = await run

      // assert
      expect(onComplete).not.toHaveBeenCalled()
      expect(outcome.signal).toBeNull()
    })

    it('does not fire onComplete when run pauses with $error', async () => {
      // arrange
      const onComplete = vi.fn()
      const runFn = vi.fn().mockRejectedValue(new Error('step failure'))
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('bad', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onComplete } })
      const outcome = await run

      // assert
      expect(onComplete).not.toHaveBeenCalled()
      expect(outcome.signal).toBe('$error')
    })

    it('does not fire onComplete when run pauses with $interrupt', async () => {
      // arrange
      const onComplete = vi.fn()
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { await (ctx['interrupt'] as (p: unknown, id: string) => Promise<unknown>)('waiting for input', 'i1'); return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('step', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onComplete } })
      const outcome = await run

      // assert
      expect(onComplete).not.toHaveBeenCalled()
      expect(outcome.signal).toBe('$interrupt')
    })

  })

  // -----------------------------------------------------------------------
  // Group 5: onInterrupt firing
  // -----------------------------------------------------------------------

  describe('onInterrupt firing', () => {

    it('fires onInterrupt with prompt and interruptId when ctx.interrupt() pauses the run', async () => {
      // arrange
      const onInterrupt = vi.fn()
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { await (ctx['interrupt'] as (p: unknown, id: string) => Promise<unknown>)({ type: 'confirm', question: 'proceed?' }, 'interrupt-abc'); return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('askUser', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onInterrupt } })
      const outcome = await run

      // assert
      expect(onInterrupt).toHaveBeenCalledOnce()
      expect(onInterrupt).toHaveBeenCalledWith({ type: 'confirm', question: 'proceed?' }, 'interrupt-abc')
      expect(outcome.signal).toBe('$interrupt')
    })

    it('does not fire onInterrupt when run stops via AbortSignal', async () => {
      // arrange
      const onInterrupt = vi.fn()
      const controller = new AbortController()
      const runFn = vi.fn().mockResolvedValue({})
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})
      controller.abort()

      // act
      const run = agent.run({}, { events: { onInterrupt }, signal: controller.signal })
      const outcome = await run

      // assert
      expect(onInterrupt).not.toHaveBeenCalled()
      expect(outcome.signal).toBeNull()
    })

    it('does not fire onInterrupt when run pauses with a non-interrupt error', async () => {
      // arrange
      const onInterrupt = vi.fn()
      const runFn = vi.fn().mockRejectedValue(new Error('domain error'))
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('fail', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onInterrupt } })
      const outcome = await run

      // assert
      expect(onInterrupt).not.toHaveBeenCalled()
      expect(outcome.signal).toBe('$error')
    })

    it('does not fire onInterrupt when ctx.interrupt() finds a stored response (resume path)', async () => {
      // arrange
      const onInterrupt = vi.fn()
      let callCount = 0
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { callCount++; await (ctx['interrupt'] as (p: unknown, id: string) => Promise<unknown>)('confirm?', 'i1'); return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('askTwice', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})
      const firstRun = agent.run({}, { events: { onInterrupt } })
      await firstRun
      onInterrupt.mockClear()
      const secondRun = firstRun.resume('yes', 'i1')

      // act
      const outcome = await secondRun

      // assert
      expect(onInterrupt).not.toHaveBeenCalled()
      expect(outcome.signal).toBe('done')
    })

  })

  // -----------------------------------------------------------------------
  // Group 6: onStoreError firing
  // -----------------------------------------------------------------------

  describe('onStoreError firing', () => {

    it('fires onStoreError with load phase when session store load throws', async () => {
      // arrange
      const onStoreError = vi.fn()
      const loadError = new Error('store read failed')
      const stubStore: SessionStore = makeStubStore({ load: vi.fn().mockRejectedValue(loadError), save: vi.fn().mockResolvedValue(undefined) })
      const runFn = vi.fn().mockResolvedValue({})
      const h = createHarness<Ctx>()({}).store({ session: stubStore }).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onStoreError } })
      const outcome = await run

      // assert
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(onStoreError).toHaveBeenCalledWith(expect.any(Error), 'load')
      expect(outcome.signal).toBe('$error')
      expect(runFn).not.toHaveBeenCalled()
    })

    it('fires onStoreError with persist phase when session store save throws at run end', async () => {
      // arrange
      const onStoreError = vi.fn()
      const saveError = new Error('store write failed')
      // terminal save fails — tests the persist-phase path (in-flight save removed in F_RH)
      const saveFn = vi.fn()
        .mockRejectedValue(saveError)
      const stubStore: SessionStore = makeStubStore({ load: vi.fn().mockResolvedValue(null), save: saveFn })
      const runFn = vi.fn().mockResolvedValue({ result: 'computed' })
      const h = createHarness<Ctx>()({}).store({ session: stubStore }).loop(l => l.start().step('compute', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onStoreError } })
      const outcome = await run

      // assert
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(onStoreError).toHaveBeenCalledWith(saveError, 'persist')
      expect(outcome.signal).toBe('done')
      expect(outcome.state.result).toBe('computed')
    })

  })

  // -----------------------------------------------------------------------
  // Group 7: LLM/tool callback injection into ctx.events
  // -----------------------------------------------------------------------

  describe('ctx.events injection', () => {

    it('injects all four LLM/tool callbacks into ctx.events with identity function references', async () => {
      // arrange
      const onLlmCall = vi.fn()
      const onLlmResponse = vi.fn()
      const onToolCall = vi.fn()
      const onToolResult = vi.fn()
      let capturedCtxEvents: unknown
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { capturedCtxEvents = ctx['events']; return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('step', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onLlmCall, onLlmResponse, onToolCall, onToolResult } })
      await run

      // assert
      expect((capturedCtxEvents as any).onLlmCall).toBe(onLlmCall) // any: capturedCtxEvents is unknown; runtime shape is verified here
      expect((capturedCtxEvents as any).onLlmResponse).toBe(onLlmResponse) // any: same
      expect((capturedCtxEvents as any).onToolCall).toBe(onToolCall) // any: same
      expect((capturedCtxEvents as any).onToolResult).toBe(onToolResult) // any: same
    })

    it('sets ctx.events to {} when no events key is present in resources', async () => {
      // arrange
      let capturedCtxEvents: unknown = 'not-set'
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { capturedCtxEvents = ctx['events']; return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('step', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, {})
      await run

      // assert
      expect(capturedCtxEvents).toEqual({})
      expect(typeof capturedCtxEvents).toBe('object')
    })

    it('populates present callbacks and leaves absent callbacks as undefined in ctx.events', async () => {
      // arrange
      const onLlmCall = vi.fn()
      let capturedCtxEvents: Record<string, unknown> | undefined
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { capturedCtxEvents = ctx['events'] as Record<string, unknown>; return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('step', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onLlmCall } })
      await run

      // assert
      expect(capturedCtxEvents!.onLlmCall).toBe(onLlmCall)
      expect(capturedCtxEvents!.onLlmResponse).toBeUndefined()
      expect(capturedCtxEvents!.onToolCall).toBeUndefined()
      expect(capturedCtxEvents!.onToolResult).toBeUndefined()
    })

  })

  // -----------------------------------------------------------------------
  // Group 8: Resume paths and event continuity
  // -----------------------------------------------------------------------

  describe('resume paths and event continuity', () => {

    it('same-process run.resume() fires event callbacks for steps in the resumed execution', async () => {
      // arrange
      const stepEndNames: string[] = []
      const onAfterStep = vi.fn().mockImplementation((name: string) => { stepEndNames.push(name) })
      let callCount = 0
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { callCount++; if (callCount === 1) { await (ctx['interrupt'] as (p: unknown, id: string) => Promise<unknown>)('input needed', 'i1') }; return { visited: callCount } })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})
      const firstRun = agent.run({}, { events: { onAfterStep } })
      await firstRun
      onAfterStep.mockClear()
      const resumedRun = firstRun.resume('yes', 'i1')

      // act
      const outcome = await resumedRun

      // assert
      expect(onAfterStep).toHaveBeenCalledOnce()
      expect(onAfterStep).toHaveBeenCalledWith('work', expect.objectContaining({ visited: 2 }))
      expect(outcome.signal).toBe('done')
    })

    it('cross-process agent.resume() with no events in resources sets ctx.events to {}', async () => {
      // arrange
      let capturedCtxEvents: unknown = 'not-set'
      const runFn = vi.fn().mockImplementation(async (_s: unknown, ctx: Record<string, unknown>) => { capturedCtxEvents = ctx['events']; return {} })
      const stubStore: SessionStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          runId: 'r1',
          sessionId: 'session-123',
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'paused' as const,
          initialState: {},
          finalState: { $interrupt: { interruptId: 'i1', prompt: 'q' }, $interruptResponses: {} },
          step: 'work',
        }),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Ctx>()({}).store({ session: stubStore }).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const resumeHandle = agent.resume('yes', 'session-123', 'i1')
      const outcome = await resumeHandle

      // assert
      expect(capturedCtxEvents).toEqual({})
      expect(outcome.signal).toBe('done')
    })

  })

  // -----------------------------------------------------------------------
  // Group 9: Cross-run isolation
  // -----------------------------------------------------------------------

  describe('cross-run isolation', () => {

    it('two concurrent runs on different sessions fire only their own onAfterStep callbacks', async () => {
      // arrange
      const callsForA: string[] = []
      const callsForB: string[] = []
      const onAfterStepA = vi.fn().mockImplementation((name: string) => callsForA.push(name))
      const onAfterStepB = vi.fn().mockImplementation((name: string) => callsForB.push(name))
      const runAFn = vi.fn().mockImplementation(() => new Promise<Record<string, unknown>>(resolve => setTimeout(() => resolve({ from: 'A' }), 10)))
      const runBFn = vi.fn().mockImplementation(() => new Promise<Record<string, unknown>>(resolve => setTimeout(() => resolve({ from: 'B' }), 5)))
      const hA = createHarness<Ctx>()({}).loop(l => l.start().step('stepA', { run: runAFn, route: () => 'done' }).on('done').end())
      const agentA = createAgent(hA, {})
      const hB = createHarness<Ctx>()({}).loop(l => l.start().step('stepB', { run: runBFn, route: () => 'done' }).on('done').end())
      const agentB = createAgent(hB, {})

      // act
      const [outcomeA, outcomeB] = await Promise.all([
        agentA.run({}, { sessionId: 'session-A', events: { onAfterStep: onAfterStepA } }),
        agentB.run({}, { sessionId: 'session-B', events: { onAfterStep: onAfterStepB } }),
      ])

      // assert
      expect(callsForA).toEqual(['stepA'])
      expect(callsForB).toEqual(['stepB'])
      expect(onAfterStepA).not.toHaveBeenCalledWith('stepB', expect.anything())
      expect(onAfterStepB).not.toHaveBeenCalledWith('stepA', expect.anything())
      void outcomeA
      void outcomeB
    })

  })

  // -----------------------------------------------------------------------
  // Group 10: Callback ordering constraints
  // -----------------------------------------------------------------------

  describe('callback ordering constraints', () => {

    it('onBeforeStep fires before step.run is invoked', async () => {
      // arrange
      const callOrder: string[] = []
      const onBeforeStep = vi.fn().mockImplementation(() => callOrder.push('onBeforeStep'))
      const runFn = vi.fn().mockImplementation(async () => { callOrder.push('run'); return {} })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('track', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onBeforeStep } })
      await run

      // assert
      expect(callOrder[0]).toBe('onBeforeStep')
      expect(callOrder[1]).toBe('run')
    })

    it('onAfterStep fires after run and applyUpdate, but before route', async () => {
      // arrange
      const callOrder: string[] = []
      const stateAtOnStepEnd: Record<string, unknown>[] = []
      const onAfterStep = vi.fn().mockImplementation((_name: string, s: Record<string, unknown>) => { callOrder.push('onAfterStep'); stateAtOnStepEnd.push({ ...s }) })
      const routeFn = vi.fn().mockImplementation(() => { callOrder.push('route'); return 'done' })
      const runFn = vi.fn().mockImplementation(async () => { callOrder.push('run'); return { x: 1 } })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('ordered', { run: runFn, route: routeFn }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: { onAfterStep } })
      await run

      // assert
      expect(callOrder).toEqual(['run', 'onAfterStep', 'route'])
      expect(stateAtOnStepEnd[0]!.x).toBe(1)
    })

  })

  // -----------------------------------------------------------------------
  // Group 11: Callback throw propagation
  // -----------------------------------------------------------------------

  describe('callback throw propagation', () => {

    it('a throwing onAfterStep callback propagates the exception out of the await run promise', async () => {
      // arrange
      const callbackError = new Error('callback blew up')
      const onAfterStep = vi.fn().mockImplementation(() => { throw callbackError })
      const runFn = vi.fn().mockResolvedValue({})
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('step', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})
      const run = agent.run({}, { events: { onAfterStep } })

      // act / assert
      await expect(run).rejects.toThrow(callbackError)
    })

  })

  // -----------------------------------------------------------------------
  // Group 12: No-op when events are omitted or empty
  // -----------------------------------------------------------------------

  describe('no-op when events are omitted or empty', () => {

    it('no callbacks fire and run completes normally when no events key is provided', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ data: 'result' })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({ initial: true }, {})
      const outcome = await run

      // assert
      expect(outcome.signal).toBe('done')
      expect(outcome.state.data).toBe('result')
      expect(runFn).toHaveBeenCalledOnce()
    })

    it('no callbacks fire and run completes normally when events is empty object', async () => {
      // arrange
      const runFn = vi.fn().mockResolvedValue({ x: 42 })
      const h = createHarness<Ctx>()({}).loop(l => l.start().step('work', { run: runFn, route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const run = agent.run({}, { events: {} })
      const outcome = await run

      // assert
      expect(outcome.signal).toBe('done')
      expect(outcome.state.x).toBe(42)
      expect(runFn).toHaveBeenCalledOnce()
    })

  })

})
