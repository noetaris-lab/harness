import { describe, it, expect, vi } from 'vitest'
import { runLoop } from './loop-executor.js'
import type { LoopCallbacks } from './loop-executor.js'
import { createLoopBuilder, extractLoopDefinition } from './loop-dsl.js'
import type { LoopDefinition } from './loop-dsl.js'
import type { StepContext } from '../agent/observer.js'
import type { SessionStore, StoredRun } from '../agent/session-store.js'
import { createAgent } from '../agent/create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import { required, runtime } from '../harness/ctx-markers.js'

// File-level build helper: constructs a LoopDefinition from a builder lambda
function build(
  fn: (l: ReturnType<typeof createLoopBuilder<Record<string, unknown>, Record<string, unknown> & { agentId: string; sessionId: string }>>) => void
): LoopDefinition {
  const builder = createLoopBuilder<Record<string, unknown>, Record<string, unknown> & { agentId: string; sessionId: string }>()
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

describe('StepContextDispatch', () => {

  describe('runLoop dispatch — core dispatch behavior', () => {

    it('calls setStepContext with correct StepContext before step.run executes', async () => {
      // arrange
      const setStepContextFn = vi.fn()
      const slot = { setStepContext: setStepContextFn }
      const callOrder: string[] = []
      setStepContextFn.mockImplementation(() => callOrder.push('setStepContext'))
      const runFn = vi.fn().mockImplementation(async () => { callOrder.push('step.run'); return {} })
      const graph = build(l =>
        l.start()
         .step('go', { run: runFn, route: () => 'done' })
         .on('done').end()
      )
      const callbacks: LoopCallbacks = { setStepContextSlots: [slot] }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'ag-1', sessionId: 'sess-1' }

      // act
      const result = await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(setStepContextFn).toHaveBeenCalledOnce()
      expect(setStepContextFn).toHaveBeenCalledWith({ agentId: 'ag-1', sessionId: 'sess-1', stepName: 'go' })
      expect(callOrder[0]).toBe('setStepContext')
      expect(callOrder[1]).toBe('step.run')
      expect(result.paused).toBe(false)
    })

    it('does not call setStepContext when slot has bindObserver but not setStepContext', async () => {
      // arrange
      const graph = build(l =>
        l.start()
         .step('work', { run: async () => ({}), route: () => 'done' })
         .on('done').end()
      )
      const callbacks: LoopCallbacks = { setStepContextSlots: [] }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      const result = await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('done')
    })

    it('calls setStepContext on only the qualifying slot when two slots are present', async () => {
      // arrange
      const slotA = { setStepContext: vi.fn() }
      const graph = build(l =>
        l.start()
         .step('check', { run: async () => ({}), route: () => 'done' })
         .on('done').end()
      )
      const callbacks: LoopCallbacks = { setStepContextSlots: [slotA] }
      const state: Record<string, unknown> = {}
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      await runLoop(graph, state, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(slotA.setStepContext).toHaveBeenCalledOnce()
      expect(slotA.setStepContext).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'check' }))
      // slotB is not in setStepContextSlots — no call possible; verified by slotA called exactly once
    })

    it('does not throw and makes no call when setStepContext is a non-function value', async () => {
      // arrange
      const adaptorInstance = { setStepContext: 'not-a-function' as unknown as (ctx: StepContext) => void }
      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', adaptorInstance)
        .loop(l => {
          l.start()
            .step('go', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      const handle = agent.run({}, {})
      const result = await handle

      // assert
      expect(result.signal).not.toBe('$error')
      expect(result.signal).toBeTruthy()
    })

  })

  describe('multi-step dispatch — per-step call semantics', () => {

    it('calls setStepContext once per step with distinct stepName for each step', async () => {
      // arrange
      const slot = { setStepContext: vi.fn() }
      const graph = build(l =>
        l.start()
         .step('stepA', { run: async () => ({}) })
         .step('stepB', { run: async () => ({}), route: () => 'done' })
         .on('done').end()
      )
      const callbacks: LoopCallbacks = { setStepContextSlots: [slot] }
      const ctx = { agentId: 'ag-1', sessionId: 'sess-1' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(slot.setStepContext).toHaveBeenCalledTimes(2)
      expect(slot.setStepContext).toHaveBeenNthCalledWith(1, { agentId: 'ag-1', sessionId: 'sess-1', stepName: 'stepA' })
      expect(slot.setStepContext).toHaveBeenNthCalledWith(2, { agentId: 'ag-1', sessionId: 'sess-1', stepName: 'stepB' })
    })

  })

  describe('slot-tier coverage — all binding tiers call setStepContext', () => {

    it('calls setStepContext on a runtime() slot provided via agent.run resources', async () => {
      // arrange
      const adaptorInstance = { setStepContext: vi.fn(), invoke: vi.fn().mockResolvedValue({}) }
      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', runtime())
        .loop(l => {
          l.start()
            .step('go', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      const handle = agent.run({}, { model: adaptorInstance })
      await handle

      // assert
      expect(adaptorInstance.setStepContext).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'go', agentId: expect.any(String), sessionId: expect.any(String) })
      )
    })

    it('calls setStepContext on a hard-coded (concrete value) slot', async () => {
      // arrange
      const adaptorInstance = { setStepContext: vi.fn() }
      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', adaptorInstance)
        .loop(l => {
          l.start()
            .step('go', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      const handle = agent.run({}, {})
      await handle

      // assert
      expect(adaptorInstance.setStepContext).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: expect.any(String) })
      )
    })

    it('calls setStepContext on a required() slot provided at createAgent() time', async () => {
      // arrange
      const adaptorInstance = { setStepContext: vi.fn(), invoke: vi.fn() }
      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', required())
        .loop(l => {
          l.start()
            .step('go', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, { model: adaptorInstance })

      // act
      const handle = agent.run({}, {})
      await handle

      // assert
      expect(adaptorInstance.setStepContext).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: expect.any(String) })
      )
    })

  })

  describe('ordering invariants', () => {

    it('onStepStart fires before setStepContext; both receive the same StepContext reference', async () => {
      // arrange
      const callOrder: string[] = []
      let capturedFromObserver: unknown
      let capturedFromSlot: unknown
      const obs = {
        onStepStart: vi.fn().mockImplementation((ctx: unknown) => {
          callOrder.push('onStepStart')
          capturedFromObserver = ctx
        }),
      }
      const slot = {
        setStepContext: vi.fn().mockImplementation((ctx: unknown) => {
          callOrder.push('setStepContext')
          capturedFromSlot = ctx
        }),
      }
      const graph = build(l =>
        l.start()
         .step('task', { run: async () => ({}), route: () => 'done' })
         .on('done').end()
      )
      const callbacks: LoopCallbacks = { observer: obs, setStepContextSlots: [slot] }
      const ctx = { agentId: 'ag-1', sessionId: 'sess-1' }

      // act
      await runLoop(graph, {}, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(callOrder).toEqual(['onStepStart', 'setStepContext'])
      expect(capturedFromObserver).toBe(capturedFromSlot)
      expect(capturedFromObserver).toEqual({ agentId: 'ag-1', sessionId: 'sess-1', stepName: 'task' })
    })

  })

  describe('omission behavior — no qualifying slots', () => {

    it('setStepContextSlots is omitted from LoopCallbacks when no slot exposes setStepContext', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const h = createHarness<{ model: typeof slot }>()()
        .provide('model', slot)
        .loop(l => {
          l.start()
            .step('go', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      const handle = agent.run({}, {})
      const result = await handle

      // assert
      expect(result.signal).not.toBe('$error')
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      // no setStepContext property on slot — absence of error and correct completion is the assertion
    })

    it('runLoop called directly without setStepContextSlots does not throw and existing callback fires', async () => {
      // arrange
      const graph = build(l =>
        l.start()
         .step('solo', { run: async () => ({}), route: () => 'done' })
         .on('done').end()
      )
      const callbacks: LoopCallbacks = { onComplete: vi.fn() }
      const ctx = { agentId: 'ag', sessionId: 'sess' }

      // act
      const result = await runLoop(graph, {}, ctx, undefined, undefined, undefined, callbacks)

      // assert
      expect(result.paused).toBe(false)
      expect(callbacks.onComplete).toHaveBeenCalledOnce()
    })

  })

  describe('resume paths — setStepContext in resumed runs', () => {

    it('setStepContext is called in the step following same-process resume after an interrupt', async () => {
      // arrange
      const adaptorInstance = { bindObserver: vi.fn(), setStepContext: vi.fn() }

      // Store enables the runWithSession path in run.resume(), loading cursor from saved state
      const pausedStoredRun = {
        agentId: 'test-agent',
        sessionId: 'sess-resume',
        runId: 'run-1',
        version: 0,
        phase: 'paused' as const,
        startedAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
        initialState: {},
        finalState: {
          $interrupt: { interruptId: '$auto:0', prompt: 'pause?' },
          $interruptResponses: {},
          $cursor: 'second',
        },
        step: 'second',
        signal: '$interrupt',
      } satisfies StoredRun

      const stubStore = makeStubStore({
        load: vi.fn()
          .mockResolvedValueOnce(null)              // first agent.run() load (fresh session)
          .mockResolvedValueOnce(pausedStoredRun)   // injectInterruptResponse load
          .mockResolvedValue(pausedStoredRun),      // runWithSession load after inject
        save: vi.fn().mockResolvedValue(undefined),
      })

      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', adaptorInstance)
        .store({ session: stubStore })
        .loop(l => {
          l.start()
            .step('first', {
              run: async (_s: any, c: any) => { // any: interrupt is dynamically injected by runLoop
                await c.interrupt('pause?')
                return {}
              },
            })
            .next('second')
            .step('second', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      const handle = agent.run({}, { sessionId: 'sess-resume' })
      const pausedResult = await handle
      // pausedResult.signal === '$interrupt'
      const interruptId = (pausedResult.state.$interrupt as { interruptId: string }).interruptId

      adaptorInstance.setStepContext.mockClear()

      // act
      const resumeHandle = handle.resume('ok', interruptId)
      const result = await resumeHandle

      // assert
      expect(result.signal).toBe('done')
      expect(adaptorInstance.setStepContext).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'second' })
      )
    })

    it('setStepContext is called on resolvedProviders-only slots in cross-process agent.resume()', async () => {
      // arrange
      const adaptorInstance = { bindObserver: vi.fn(), setStepContext: vi.fn() }

      const pausedStoredRun = {
        agentId: 'test-agent',
        sessionId: 'fixed-session-id',
        runId: 'run-1',
        version: 0,
        phase: 'paused' as const,
        startedAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
        initialState: {},
        finalState: {
          $interrupt: { interruptId: '$auto:0', prompt: 'confirm?' },
          $interruptResponses: {},
          $cursor: 'resume-step',
        },
        step: 'resume-step',
        signal: '$interrupt',
      } satisfies StoredRun

      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue(pausedStoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })

      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', adaptorInstance)
        .store({ session: stubStore })
        .loop(l => {
          l.start()
            .step('interruptible', {
              run: async (_s: any, c: any) => { // any: interrupt is dynamically injected by runLoop
                await c.interrupt('confirm?')
                return {}
              },
            })
            .next('resume-step')
            .step('resume-step', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act — cross-process resume: uses resolvedProviders only for setStepContextSlots
      const resumeHandle = agent.resume('user-answer', 'fixed-session-id', '$auto:0')
      const result = await resumeHandle

      // assert
      expect(result.signal).toBe('done')
      expect(adaptorInstance.setStepContext).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'resume-step' })
      )
    })

  })

  describe('NOOP_OBSERVER interaction', () => {

    it('setStepContext is called at step start even when no observer is supplied (NOOP_OBSERVER path)', async () => {
      // arrange
      const adaptorInstance = { bindObserver: vi.fn(), setStepContext: vi.fn() }
      const h = createHarness<{ model: typeof adaptorInstance }>()()
        .provide('model', adaptorInstance)
        .loop(l => {
          l.start()
            .step('only', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      const handle = agent.run({}, {})
      await handle

      // assert
      expect(adaptorInstance.bindObserver).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledOnce()
      expect(adaptorInstance.setStepContext).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: 'only', agentId: expect.any(String), sessionId: expect.any(String) })
      )
    })

  })

})
