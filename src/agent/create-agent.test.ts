import { describe, it, expect, beforeEach, vi, expectTypeOf } from 'vitest'
import {
  createAgent,
  getAgentInternals,
  MissingLoopError,
  MissingSlotError,
  RuntimeSlotInAgentError,
  UnknownSlotError,
  AgentInternalsError,
  MissingRuntimeSlotError,
  RequiredSlotInRunError,
  UnknownRunSlotError,
} from './create-agent.js'
import { NoInterruptError } from './interrupt-resume.js'
import type { RunEvents } from './event-callbacks.js'
import type { SessionStore, StoredRun } from './session-store.js'
import { createHarness, getInternals } from '../harness/harness-builder.js'
import { HarnessInternalsError } from '../harness/harness-builder.js'
import { required, runtime } from '../harness/ctx-markers.js'
import { field } from '../harness/state-field.js'
import type { LoopBuilder } from '../loop/loop-dsl.js'
import type { RunHandle } from './run-handle.js'

// -----------------------------------------------------------------------
// Shared helper: builder function that creates a minimal valid loop
// -----------------------------------------------------------------------

function buildValidLoop<S, Ctx>(l: LoopBuilder<S, Ctx>): void {
  l.start()
    .step('start', { route: () => 'done' })
    .on('done')
    .end()
}

// -----------------------------------------------------------------------
// Test groups
// -----------------------------------------------------------------------

describe('createAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Group 1: Harness prerequisites', () => {
    it('throws MissingLoopError when harness has no loop registered', () => {
      // arrange
      const h = createHarness<Record<string, never>>()({})
      // do NOT call h.loop()

      // act & assert
      expect(() => createAgent(h, {})).toThrow(MissingLoopError)
      expect(() => createAgent(h, {})).toThrow('h.loop()')
    })

    it('propagates HarnessInternalsError when h is not a real Harness', () => {
      // arrange
      const fakeHarness = {}

      // act & assert
      expect(() => createAgent(fakeHarness as any, {})).toThrow(HarnessInternalsError) // any: intentionally not a real Harness for error-case testing
    })
  })

  describe('Group 2: Slot contract validation', () => {
    it('throws UnknownSlotError when slot key has no provider declaration', () => {
      // arrange
      const h = createHarness<{ prompts: string }>()({})
        .provide('prompts', required())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { prompts: 'x', ghost: 'y' } as any)).toThrow(UnknownSlotError) // any: extra key 'ghost' is intentionally invalid — TypeScript enforces Pick<Ctx, Req> at compile time
      try {
        createAgent(h, { prompts: 'x', ghost: 'y' } as any) // any: same as above
      } catch (error) {
        expect((error as UnknownSlotError).key).toBe('ghost') // as: catch clause — error class verified by preceding toThrow assertion
        expect((error as UnknownSlotError).message).toContain('ghost') // as: same as above
      }
    })

    it('throws UnknownSlotError when harness has no provide() declarations', () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { anything: 'v' } as any)).toThrow(UnknownSlotError) // any: unknown key is intentionally invalid for error-case testing
      try {
        createAgent(h, { anything: 'v' } as any) // any: same as above
      } catch (error) {
        expect((error as UnknownSlotError).key).toBe('anything') // as: catch clause — error class verified by preceding toThrow assertion
      }
    })

    it('throws RuntimeSlotInAgentError (not UnknownSlotError) when key is declared as runtime()', () => {
      // arrange
      const h = createHarness<{ model: object }>()({})
        .provide('model', runtime())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { model: {} })).toThrow(RuntimeSlotInAgentError)
      expect(() => createAgent(h, { model: {} })).not.toThrow(UnknownSlotError)
      try {
        createAgent(h, { model: {} })
      } catch (error) {
        expect((error as RuntimeSlotInAgentError).key).toBe('model') // as: catch clause — error class verified by preceding toThrow assertion
      }
    })

    it('throws RuntimeSlotInAgentError when runtime() key is in slots alongside a valid required() key', () => {
      // arrange
      const h = createHarness<{ model: object; prompts: string }>()({})
        .provide('model', runtime())
        .provide('prompts', required())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { model: {}, prompts: 'sys' } as any)).toThrow(RuntimeSlotInAgentError) // any: runtime() key in slots is intentionally invalid — Pick<Ctx, Req> excludes runtime slots
      try {
        createAgent(h, { model: {}, prompts: 'sys' } as any) // any: same as above
      } catch (error) {
        expect((error as RuntimeSlotInAgentError).key).toBe('model') // as: catch clause — error class verified by preceding toThrow assertion
        expect((error as RuntimeSlotInAgentError).message).toContain('model') // as: same as above
        expect((error as RuntimeSlotInAgentError).message).toContain('agent.run()') // as: same as above
      }
    })

    it('throws RuntimeSlotInAgentError when one runtime() slot is passed (two runtime slots declared)', () => {
      // arrange
      const h = createHarness<{ model: object; signal: object }>()({})
        .provide('model', runtime())
        .provide('signal', runtime())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { model: {} } as any)).toThrow(RuntimeSlotInAgentError) // any: runtime() key in slots is intentionally invalid
      try {
        createAgent(h, { model: {} } as any) // any: same as above
      } catch (error) {
        expect((error as RuntimeSlotInAgentError).key).toBe('model') // as: catch clause — error class verified by preceding toThrow assertion
      }
    })

    it('throws MissingSlotError when required() slot is absent from empty slots object', () => {
      // arrange
      const h = createHarness<{ prompts: string }>()({})
        .provide('prompts', required())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, {} as any)).toThrow(MissingSlotError) // any: missing required slot is intentionally invalid for error-case testing
      try {
        createAgent(h, {} as any) // any: same as above
      } catch (error) {
        expect((error as MissingSlotError).key).toBe('prompts') // as: catch clause — error class verified by preceding toThrow assertion
        expect((error as MissingSlotError).message).toContain('prompts') // as: same as above
      }
    })

    it('throws MissingSlotError when one of two required() slots is absent', () => {
      // arrange
      const h = createHarness<{ prompts: string; apiKey: string }>()({})
        .provide('prompts', required())
        .provide('apiKey', required())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { prompts: 'sys' } as any)).toThrow(MissingSlotError) // any: missing required slot is intentionally invalid for error-case testing
      try {
        createAgent(h, { prompts: 'sys' } as any) // any: same as above
      } catch (error) {
        expect((error as MissingSlotError).key).toBe('apiKey') // as: catch clause — error class verified by preceding toThrow assertion
      }
    })
  })

  describe('Group 3: Happy path', () => {
    it('returns an Agent when all required() slots are provided', () => {
      // arrange
      const h = createHarness<{ prompts: string }>()({})
        .provide('prompts', required())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, { prompts: 'system prompt text' })).not.toThrow()
      const agent = createAgent(h, { prompts: 'system prompt text' })
      expect(agent).toBeDefined()
      expect(typeof agent.run).toBe('function')
      expect(typeof agent.resume).toBe('function')
      expect(typeof agent.status).toBe('function')
    })

    it('returns an Agent when harness has only concrete (non-marker) providers', () => {
      // arrange
      const tools = { search: () => 'result' }
      const h = createHarness<{ tools: typeof tools }>()({})
        .provide('tools', tools)
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, {})).not.toThrow()
      const agent = createAgent(h, {})
      expect(agent).toBeDefined()
    })

    it('returns an Agent when harness has only runtime() slots', () => {
      // arrange
      const h = createHarness<{ model: object }>()({})
        .provide('model', runtime())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent(h, {})).not.toThrow()
      const agent = createAgent(h, {})
      expect(agent).toBeDefined()
    })
  })

  describe('Group 4: Agent method stubs', () => {
    it('agent.resume() returns a RunHandle whose execution rejects with NoInterruptError when no store is configured', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act
      const run = agent.resume(undefined, 'session-1', 'interrupt-1')

      // assert — returns synchronously (does not throw)
      expect(run).toBeDefined()
      expect(typeof run.stop).toBe('function')
      // execution rejects with NoInterruptError (no store configured)
      await expect(run).rejects.toThrow(NoInterruptError)
    })

    it('agent.status() resolves with { phase: "fresh" } when no session store is configured', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act
      const status = await agent.status('session-1')

      // assert — F7 wires agent.status() to querySessionPhase; no store → fresh
      expect(status).toEqual({ phase: 'fresh' })
    })
  })

  describe('Group 5: AgentInternals construction', () => {
    it('AgentInternals carries loopDef, stateSchema, and storeEntries from the harness', () => {
      // arrange
      const schema = { count: field({ default: () => 0 }) }
      const h = createHarness<Record<string, never>>()(schema).loop(buildValidLoop)
      const expectedLoopDef = getInternals(h).loopDef
      const agent = createAgent(h, {})

      // act
      const internals = getAgentInternals(agent)

      // assert — loopDef must be the exact same object reference (downstream features depend on it)
      expect(internals.loopDef).toBe(expectedLoopDef)
      expect(internals.loopDef.startCalled).toBe(true)
      expect(internals.stateSchema).toEqual(schema)
      expect(internals.storeEntries).toEqual([])
    })

    it('resolvedProviders contains concrete provider value as-is', () => {
      // arrange
      const myTool = { search: () => 'result' }
      const h = createHarness<{ tools: typeof myTool }>()({})
        .provide('tools', myTool)
        .loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act
      const internals = getAgentInternals(agent)

      // assert
      expect(internals.resolvedProviders.get('tools')).toBe(myTool)
    })

    it('resolvedProviders replaces required() marker with the slot value', () => {
      // arrange
      const h = createHarness<{ prompts: string }>()({})
        .provide('prompts', required())
        .loop(buildValidLoop)
      const agent = createAgent(h, { prompts: 'sys' })

      // act
      const internals = getAgentInternals(agent)

      // assert
      expect(internals.resolvedProviders.get('prompts')).toBe('sys')
    })

    it('last-registered-wins semantics for duplicate provider keys', () => {
      // arrange
      const h = createHarness<{ model: { v: number } }>()({})
        .provide('model', { v: 1 })
        .provide('model', { v: 2 })
        .loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act
      const internals = getAgentInternals(agent)

      // assert
      expect(internals.resolvedProviders.get('model')).toEqual({ v: 2 })
    })

    it('storeEntries contains store provider entry; store value not in resolvedProviders', () => {
      // arrange
      const myStore = {}
      const myGraph = {}
      const h = createHarness<Record<string, never>>()({})
        .store({ session: myStore, knowledge: myGraph })
        .loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act
      const internals = getAgentInternals(agent)

      // assert
      expect(internals.storeEntries).toHaveLength(1)
      expect(internals.storeEntries[0]!.kind).toBe('store')
      expect(internals.storeEntries[0]!.value).toEqual({ session: myStore, knowledge: myGraph })
      expect(internals.resolvedProviders.has('session')).toBe(false)
    })
  })

  describe('Group 6: getAgentInternals guard', () => {
    it('throws AgentInternalsError for a plain object not produced by createAgent', () => {
      // arrange
      const fakeAgent = { run: () => {}, resume: () => {}, status: () => {} }

      // act & assert
      expect(() => getAgentInternals(fakeAgent as any)).toThrow(AgentInternalsError) // any: intentionally not a real Agent for guard testing
      expect(() => getAgentInternals(fakeAgent as any)).toThrow(/not produced by createAgent/) // any: same as above
    })

    it('throws AgentInternalsError for null', () => {
      // act & assert
      expect(() => getAgentInternals(null as any)).toThrow(AgentInternalsError) // any: null is intentionally invalid for guard testing
    })
  })

  describe('Group 7: Error class invariants', () => {
    it('MissingLoopError has correct name and instanceof chain', () => {
      // arrange
      const error = new MissingLoopError()

      // act & assert
      expect(error.name).toBe('MissingLoopError')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(MissingLoopError)
      expect(error.message).toContain('h.loop()')
    })

    it('MissingSlotError has correct name, key, and message', () => {
      // arrange
      const error = new MissingSlotError('prompts')

      // act & assert
      expect(error.name).toBe('MissingSlotError')
      expect(error.key).toBe('prompts')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(MissingSlotError)
      expect(error.message).toContain('prompts')
    })

    it('RuntimeSlotInAgentError has correct name, key, and message mentioning agent.run()', () => {
      // arrange
      const error = new RuntimeSlotInAgentError('model')

      // act & assert
      expect(error.name).toBe('RuntimeSlotInAgentError')
      expect(error.key).toBe('model')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(RuntimeSlotInAgentError)
      expect(error.message).toContain('model')
      expect(error.message).toContain('agent.run()')
    })

    it('UnknownSlotError has correct name, key, and message', () => {
      // arrange
      const error = new UnknownSlotError('ghost')

      // act & assert
      expect(error.name).toBe('UnknownSlotError')
      expect(error.key).toBe('ghost')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(UnknownSlotError)
      expect(error.message).toContain('ghost')
    })

    it('AgentInternalsError has correct name and instanceof chain', () => {
      // arrange
      const error = new AgentInternalsError()

      // act & assert
      expect(error.name).toBe('AgentInternalsError')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(AgentInternalsError)
    })
  })

  // -----------------------------------------------------------------------
  // F8 — agent.run() tests
  // -----------------------------------------------------------------------

  describe('agent.run()', () => {
    describe('Group 1: Synchronous return', () => {
      it('returns RunHandle before any step executes', async () => {
        // arrange
        const stepCallCount = { n: 0 }
        const h = createHarness<{ model: unknown }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', {
                run: async () => { stepCallCount.n++; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4' })
        const stepCountAfterRun = stepCallCount.n

        // assert
        expect(typeof run.then).toBe('function')
        expect(typeof run.stop).toBe('function')
        expect(typeof run.sessionId).toBe('string')
        expect(typeof run.runId).toBe('string')
        expect(stepCountAfterRun).toBe(0)

        // cleanup
        await run
      })
    })

    describe('Group 2: Session identity', () => {
      it('uses provided string sessionId from resources', async () => {
        // arrange
        const h = createHarness<{ model: unknown }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', sessionId: 'my-session-123' })
        await run

        // assert
        expect(run.sessionId).toBe('my-session-123')
      })

      it('generates a UUID when resources has no sessionId key', async () => {
        // arrange
        const h = createHarness<{ model: unknown }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4' })
        await run

        // assert
        expect(run.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      })

      it('generates a UUID when resources.sessionId is a non-string value', async () => {
        // arrange
        const h = createHarness<{ model: unknown }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', sessionId: 42 })
        await run

        // assert
        expect(run.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
        expect(run.sessionId).not.toBe('42')
      })

      it('runId is a UUID available synchronously on the returned RunHandle', async () => {
        // arrange
        const h = createHarness<{ model: unknown }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4' })

        // assert — available before awaiting
        expect(run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

        await run
      })

      it('each agent.run() call produces a distinct runId', async () => {
        // arrange
        const h = createHarness<{ model: unknown }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run1 = agent.run({}, { model: 'gpt-4', sessionId: 'sess-a' })
        await run1
        const run2 = agent.run({}, { model: 'gpt-4', sessionId: 'sess-b' })
        await run2

        // assert
        expect(run1.runId).not.toBe(run2.runId)
      })
    })

    describe('Group 3: ctx assembly', () => {
      it('runtime slot value is forwarded into ctx inside step execution', async () => {
        // arrange
        let capturedCtx: Record<string, unknown> | null = null
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', {
                run: async (s, ctx) => { capturedCtx = ctx as Record<string, unknown>; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        await agent.run({}, { model: 'gpt-4' })

        // assert
        expect(capturedCtx).not.toBeNull()
        expect(capturedCtx!['model']).toBe('gpt-4')
      })

      it('ctx.sessionId equals run.sessionId inside step execution', async () => {
        // arrange
        let capturedCtxSessionId: unknown = undefined
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', {
                run: async (s, ctx) => {
                  capturedCtxSessionId = ctx.sessionId
                  return {}
                },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', sessionId: 'ctx-test-session' })
        await run

        // assert
        expect(run.sessionId).toBe('ctx-test-session')
        expect(capturedCtxSessionId).toBe('ctx-test-session')
      })

      it('concrete resolvedProvider value is present in ctx and not overridden by resources', async () => {
        // arrange
        const concreteTools = { call: vi.fn() }
        let capturedCtx: Record<string, unknown> | null = null
        const h = createHarness<{ model: string; tools: typeof concreteTools }>()()
          .provide('tools', concreteTools)
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', {
                run: async (s, ctx) => { capturedCtx = ctx as Record<string, unknown>; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        await agent.run({}, { model: 'gpt-4' })

        // assert
        expect(capturedCtx!['tools']).toBe(concreteTools)
      })
    })

    describe('Group 4: AbortSignal wiring', () => {
      it('abort() called during step execution stops run at next checkpoint', async () => {
        // arrange
        const ac = new AbortController()
        let unblockStep1!: () => void
        const step1Done = new Promise<void>(r => { unblockStep1 = r })
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('step1', {
                run: async () => { await step1Done; return {} },
              })
              .step('step2', {
                run: async () => ({}),
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', signal: ac.signal })
        ac.abort()
        unblockStep1()
        const result = await run

        // assert
        expect(result.signal).toBeNull()
      })

      it('already-aborted signal causes run to stop before first step executes', async () => {
        // arrange
        const ac = new AbortController()
        ac.abort()
        const stepCallCount = { n: 0 }
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', {
                run: async () => { stepCallCount.n++; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', signal: ac.signal })
        const result = await run

        // assert
        expect(result.signal).toBeNull()
        expect(stepCallCount.n).toBe(0)
      })

      it('non-AbortSignal signal value is silently ignored and run completes normally', async () => {
        // arrange
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', signal: 'abort' })
        const result = await run

        // assert
        expect(result.signal).toBe('done')
      })
    })

    describe('Group 5: Stop behavior', () => {
      it('run.stop() resolves run with { state, signal: null }', async () => {
        // arrange
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4' })
        run.stop()
        const result = await run

        // assert
        expect(result.signal).toBeNull()
        expect(result.state).toBeDefined()
      })
    })

    describe('Group 6: Reserved key passthrough', () => {
      it('reserved keys alongside a valid runtime slot produce no validation error', async () => {
        // arrange
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, {
          model: 'gpt-4',
          sessionId: 'reserved-test',
          signal: new AbortController().signal,
          events: {},
        })

        // assert — synchronous throw would propagate out of agent.run() before returning a handle
        expect(run).toBeDefined()

        // cleanup
        await run
      })
    })

    describe('Group 7: Step tracking (currentStep)', () => {
      it('currentStep shows active step name when onBeforeStep has fired for that step', async () => {
        // arrange
        let unblockStep!: () => void
        const blocker = new Promise<void>(r => { unblockStep = r })
        let run: RunHandle
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('think', {
                run: async () => { await blocker; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        run = agent.run({}, { model: 'gpt-4' })
        await new Promise(r => setTimeout(r, 0))
        const observed = run.currentStep
        unblockStep()
        await run

        // assert
        expect(observed).toBe('think')
      })

      it('currentStep is null after run completes normally', async () => {
        // arrange
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4' })
        await run

        // assert
        expect(run.currentStep).toBeNull()
      })
    })

    describe('Group 8: Validation errors', () => {
      // Shared harness: required() 'prompts', runtime() 'model', concrete 'tools'
      const concreteTools = { fetch: vi.fn() }
      const h = createHarness<{ model: string; prompts: string; tools: typeof concreteTools }>()()
        .provide('prompts', required())
        .provide('model', runtime())
        .provide('tools', concreteTools)
        .loop(l => {
          l.start()
            .step('run', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent(h, { prompts: 'You are a helpful assistant.' })

      it('throws UnknownRunSlotError when resources contains a key not declared in harness', () => {
        // arrange — shared harness above

        // act
        const act = () => agent.run({}, { model: 'gpt-4', foo: 'bar' })

        // assert
        expect(act).toThrow(UnknownRunSlotError)
        expect(act).toThrow(expect.objectContaining({ key: 'foo' }))
      })

      it('throws RequiredSlotInRunError when resources contains a required() key', () => {
        // arrange — shared harness above

        // act
        const act = () => agent.run({}, { model: 'gpt-4', prompts: 'override' })

        // assert
        expect(act).toThrow(RequiredSlotInRunError)
        expect(act).toThrow(expect.objectContaining({ key: 'prompts' }))
      })

      it('throws UnknownRunSlotError when resources contains a concrete provider key', () => {
        // arrange — shared harness above

        // act
        const act = () => agent.run({}, { model: 'gpt-4', tools: { fetch: vi.fn() } })

        // assert
        expect(act).toThrow(UnknownRunSlotError)
        expect(act).toThrow(expect.objectContaining({ key: 'tools' }))
      })

      it('throws MissingRuntimeSlotError when a declared runtime() slot is absent from resources', () => {
        // arrange — shared harness above

        // act
        const act = () => agent.run({}, {})

        // assert
        expect(act).toThrow(MissingRuntimeSlotError)
        expect(act).toThrow(expect.objectContaining({ key: 'model' }))
      })

      it('throws UnknownRunSlotError (not MissingRuntimeSlotError) when resources has both unknown key and missing runtime slot', () => {
        // arrange — shared harness above

        // act
        const act = () => agent.run({}, { foo: 'bar' })

        // assert
        expect(act).toThrow(UnknownRunSlotError)
        expect(act).toThrow(expect.objectContaining({ key: 'foo' }))
      })

      it('throws UnknownRunSlotError (not RequiredSlotInRunError) when resources has both unknown key and required() key', () => {
        // arrange — shared harness above

        // act
        const act = () => agent.run({}, { model: 'gpt-4', prompts: 'x', foo: 'bar' })

        // assert
        expect(act).toThrow(UnknownRunSlotError)
        expect(act).toThrow(expect.objectContaining({ key: 'foo' }))
      })
    })

    describe('Group 9: Edge cases', () => {
      it('no validation error when resources has only reserved keys and harness has no runtime slots', async () => {
        // arrange
        const h = createHarness<{ sessionId: string }>()()
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { sessionId: 'reserved-only' })

        // assert — synchronous throw would propagate out of agent.run() before returning a handle
        expect(run).toBeDefined()

        // cleanup
        await run
      })

      it('no validation error when resources is empty and harness has no runtime slots', async () => {
        // arrange
        const h = createHarness<{ sessionId: string }>()()
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const act = () => agent.run({}, {})

        // assert
        expect(act).not.toThrow()

        // cleanup
        await agent.run({}, {})
      })

      it('AbortSignal that fires after run completes has no observable effect', async () => {
        // arrange
        const ac = new AbortController()
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run = agent.run({}, { model: 'gpt-4', signal: ac.signal })
        const result = await run
        ac.abort()

        // assert
        expect(result.signal).toBe('done')
        expect(run.currentStep).toBeNull()
      })

      it('fresh stopFlag per call — stop() on first run does not affect second run', async () => {
        // arrange
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', { run: async () => ({}), route: () => 'done' })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run1 = agent.run({}, { model: 'gpt-4' })
        run1.stop()
        const result1 = await run1

        const run2 = agent.run({}, { model: 'gpt-4' })
        const result2 = await run2

        // assert
        expect(result1.signal).toBeNull()
        expect(result2.signal).toBe('done')
      })

      it("fresh stepRef per call — run1's finally() does not clear run2's currentStep", async () => {
        // arrange
        let callCount = 0
        let unblockRun2!: () => void
        const blocker = new Promise<void>(r => { unblockRun2 = r })
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('think', {
                run: async () => {
                  callCount++
                  if (callCount === 2) await blocker
                  return {}
                },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        const run1 = agent.run({}, { model: 'gpt-4' })
        await run1

        const run2 = agent.run({}, { model: 'gpt-4' })
        await new Promise(r => setTimeout(r, 0))
        const stepAfterRun1 = run2.currentStep
        unblockRun2()
        await run2

        // assert
        expect(stepAfterRun1).toBe('think')
      })

      it('ctx is a fresh plain object literal per call — not a shared reference from agentInternals', async () => {
        // arrange
        const ctxRefs: Array<Record<string, unknown>> = []
        const h = createHarness<{ model: string }>()()
          .provide('model', runtime())
          .loop(l => {
            l.start()
              .step('run', {
                run: async (s, ctx) => {
                  ctxRefs.push(ctx as Record<string, unknown>)
                  return {}
                },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent(h, {})

        // act
        await agent.run({}, { model: 'gpt-4' })
        await agent.run({}, { model: 'gpt-4' })

        // assert
        expect(ctxRefs).toHaveLength(2)
        expect(ctxRefs[0]).not.toBe(ctxRefs[1])
      })
    })
  })

  // -----------------------------------------------------------------------
  // F14 — run-listeners component tests
  // -----------------------------------------------------------------------

  // Shared helper for cross-process resume tests (Case 5.1)
  function makeStubStore(overrides: Partial<SessionStore> = {}): SessionStore {
    return {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  describe("Group: 'listeners' as a reserved key", () => {
    it("harness slot named 'listeners' is NOT injected into ctx when listeners key is also passed in resources", async () => {
      // arrange
      let capturedCtx: Record<string, unknown> | null = null
      const h = createHarness<{ listeners: Record<string, unknown> }>()()
        .provide('listeners', runtime())
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                capturedCtx = ctx as Record<string, unknown>
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})
      const fn = vi.fn()

      // act
      await agent.run({}, { listeners: { 'x': fn } })

      // assert
      expect(capturedCtx!['listeners']).toBeUndefined()
    })

    it("ctx.emit dispatches to the listeners map from resources even when a harness slot named 'listeners' exists", async () => {
      // arrange
      const h = createHarness<{ listeners: Record<string, unknown> }>()()
        .provide('listeners', runtime())
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;(ctx.emit as (name: string, payload?: unknown) => void)('x', 'payload')
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})
      const fn = vi.fn()

      // act
      await agent.run({}, { listeners: { 'x': fn } })

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith('payload')
    })

    it("no listeners key and no harness declaration — no error and ctx.emit is a no-op", async () => {
      // arrange
      const h = createHarness<{ model: string }>()()
        .provide('model', runtime())
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;ctx.emit?.('x', 'val')
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const result = await agent.run({}, { model: 'gpt-4' })

      // assert
      expect(result.signal).toBe('done')
    })

    it("passing listeners key without any harness declaration does not throw UnknownRunSlotError", async () => {
      // arrange
      const h = createHarness<{ model: string }>()()
        .provide('model', runtime())
        .loop(l => {
          l.start()
            .step('go', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent(h, {})
      const fn = vi.fn()

      // act
      const promise = agent.run({}, { model: 'gpt-4', listeners: { 'x': fn } })

      // assert
      await expect(promise).resolves.toBeDefined()
    })
  })

  describe('Group: listeners extraction and dispatch through the loop', () => {
    it('ctx.emit fires the registered listener with the supplied payload', async () => {
      // arrange
      const fn = vi.fn()
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;ctx.emit('llm:call', { model: 'gpt-4' })
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      await agent.run({}, { listeners: { 'llm:call': fn } })

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith({ model: 'gpt-4' })
    })

    it('ctx.emit with unregistered name does not call fn and run completes normally', async () => {
      // arrange
      const fn = vi.fn()
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;ctx.emit('other', 'value')
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const result = await agent.run({}, { listeners: { 'llm:call': fn } })

      // assert
      expect(fn).not.toHaveBeenCalled()
      expect(result.signal).toBe('done')
    })

    it('ctx.emit is a no-op when resources has no listeners key', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;ctx.emit('x', 99)
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const result = await agent.run({}, {})

      // assert
      expect(result.signal).toBe('done')
    })

    it('ctx.emit is a no-op when listeners is an empty object', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;ctx.emit('x', 99)
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const result = await agent.run({}, { listeners: {} })

      // assert
      expect(result.signal).toBe('done')
    })

    it('listener is called once per ctx.emit call across multiple steps in the same run', async () => {
      // arrange
      const fn = vi.fn()
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('stepA', {
              run: async (_s, ctx) => {
                ;ctx.emit('e', 1)
                return {}
              },
            })
            .next('stepB')
            .step('stepB', {
              run: async (_s, ctx) => {
                ;ctx.emit('e', 2)
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      await agent.run({}, { listeners: { 'e': fn } })

      // assert
      expect(fn).toHaveBeenCalledTimes(2)
      expect(fn).toHaveBeenNthCalledWith(1, 1)
      expect(fn).toHaveBeenNthCalledWith(2, 2)
    })
  })

  describe('Group: ctx.events removal — LLM/tool callbacks removed', () => {
    it("ctx inside a step does not have an 'events' property after RunListeners change", async () => {
      // arrange
      let capturedCtx: Record<string, unknown> | null = null
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                capturedCtx = ctx as Record<string, unknown>
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      await agent.run({}, { events: { onBeforeStep: () => {} } })

      // assert
      expect('events' in capturedCtx!).toBe(false)
    })

    it('TypeScript rejects events object containing onLlmCall at compile time', () => {
      // arrange & act & assert
      expectTypeOf<RunEvents>().not.toHaveProperty('onLlmCall')
    })

    it('onBeforeStep framework callback in events is still called; ctx.events is absent', async () => {
      // arrange
      const onBeforeStep = vi.fn()
      let capturedCtx: Record<string, unknown> | null = null
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                capturedCtx = ctx as Record<string, unknown>
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      await agent.run({}, { events: { onBeforeStep } })

      // assert
      expect(onBeforeStep).toHaveBeenCalledOnce()
      expect(onBeforeStep).toHaveBeenCalledWith('go', expect.any(Object))
      expect('events' in capturedCtx!).toBe(false)
    })
  })

  describe('Group: Same-process resume — listeners are preserved', () => {
    it('ctx.emit in resumed step calls the same listener from the original run', async () => {
      // arrange
      const fn = vi.fn()
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('step1', {
              run: async (_s, ctx) => {
                await ctx.interrupt('prompt?')
                return {}
              },
            })
            .next('step2')
            .step('step2', {
              run: async (_s, ctx) => {
                ;ctx.emit('e', 'from-resume')
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const run1 = agent.run({}, { listeners: { 'e': fn } })
      const outcome1 = await run1
      const run2 = run1.resume('user-response', '$auto:0')
      await run2

      // assert
      expect(outcome1.signal).toBe('$interrupt')
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith('from-resume')
    })
  })

  describe('Group: Cross-process resume — listeners are not available', () => {
    it('ctx.emit in a cross-process resumed step is a no-op — no listener is called', async () => {
      // arrange
      const fn = vi.fn()
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          sessionId: 'sess-1',
          runId: 'run-1',
          phase: 'paused',
          startedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          initialState: {},
          finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: 'prompt?' },
            $interruptResponses: {},
            $cursor: 'step2',
          },
          step: 'step2',
          signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()()
        .store({ session: store })
        .loop(l => {
          l.start()
            .step('step1', { run: async () => ({}), route: () => 'done' })
            .on('done').to('step2')
            .step('step2', {
              run: async (_s, ctx) => {
                ;ctx.emit('e', 'cross-process')
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const resumeRun = agent.resume('user-response', 'sess-1', '$auto:0')
      await resumeRun

      // assert
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('Group: Isolation — no listener leakage between runs', () => {
    it('two concurrent runs with different listeners dispatch only to their own listeners', async () => {
      // arrange
      const fnA = vi.fn()
      const fnB = vi.fn()
      let unblockA!: () => void
      let unblockB!: () => void
      const blockerA = new Promise<void>(r => { unblockA = r })
      const blockerB = new Promise<void>(r => { unblockB = r })
      const h = createHarness<{ blocker: Promise<void> }>()()
        .provide('blocker', runtime())
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                await (ctx as Record<string, unknown>)['blocker'] as Promise<void>
                ;ctx.emit('e', ctx.sessionId)
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      const runA = agent.run({}, {
        blocker: blockerA,
        sessionId: 'sess-A',
        listeners: { 'e': fnA },
      })
      const runB = agent.run({}, {
        blocker: blockerB,
        sessionId: 'sess-B',
        listeners: { 'e': fnB },
      })
      unblockA()
      unblockB()
      await Promise.all([runA, runB])

      // assert
      expect(fnA).toHaveBeenCalledOnce()
      expect(fnA).toHaveBeenCalledWith('sess-A')
      expect(fnB).toHaveBeenCalledOnce()
      expect(fnB).toHaveBeenCalledWith('sess-B')
    })

    it('second sequential run uses its own listeners — first run listeners do not fire', async () => {
      // arrange
      const fnA = vi.fn()
      const fnB = vi.fn()
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start()
            .step('go', {
              run: async (_s, ctx) => {
                ;ctx.emit('e', 'payload')
                return {}
              },
              route: () => 'done',
            })
            .on('done').end()
        })
      const agent = createAgent(h, {})

      // act
      await agent.run({}, { listeners: { 'e': fnA } })
      await agent.run({}, { listeners: { 'e': fnB } })

      // assert
      expect(fnA).toHaveBeenCalledTimes(1)
      expect(fnB).toHaveBeenCalledTimes(1)
    })
  })
})
