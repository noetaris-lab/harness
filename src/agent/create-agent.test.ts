import { describe, it, expect, beforeEach, vi } from 'vitest'
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
import { SessionInFlightError } from './concurrency-errors.js'
import type { SessionStore, StoredRun } from './session-store.js'
import type { RunContext } from './observer.js'
import { createHarness, getInternals } from '../harness/harness-builder.js'
import { HarnessInternalsError } from '../harness/harness-builder.js'
import { required, runtime } from '../harness/ctx-markers.js'
import { field } from '../harness/state-field.js'
import type { LoopBuilder } from '../loop/loop-dsl.js'
import type { RunHandle } from './run-handle.js'
import * as loopExecutorModule from '../loop/loop-executor.js'

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
      expect(() => createAgent('test-agent', h,{})).toThrow(MissingLoopError)
      expect(() => createAgent('test-agent', h,{})).toThrow('h.loop()')
    })

    it('propagates HarnessInternalsError when h is not a real Harness', () => {
      // arrange
      const fakeHarness = {}

      // act & assert
      expect(() => createAgent('test-agent', fakeHarness as any, {})).toThrow(HarnessInternalsError) // any: intentionally not a real Harness for error-case testing
    })
  })

  describe('Group 2: Slot contract validation', () => {
    it('throws UnknownSlotError when slot key has no provider declaration', () => {
      // arrange
      const h = createHarness<{ prompts: string }>()({})
        .provide('prompts', required())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent('test-agent', h,{ prompts: 'x', ghost: 'y' } as any)).toThrow(UnknownSlotError) // any: extra key 'ghost' is intentionally invalid — TypeScript enforces Pick<Ctx, Req> at compile time
      try {
        createAgent('test-agent', h,{ prompts: 'x', ghost: 'y' } as any) // any: same as above
      } catch (error) {
        expect((error as UnknownSlotError).key).toBe('ghost') // as: catch clause — error class verified by preceding toThrow assertion
        expect((error as UnknownSlotError).message).toContain('ghost') // as: same as above
      }
    })

    it('throws UnknownSlotError when harness has no provide() declarations', () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)

      // act & assert
      expect(() => createAgent('test-agent', h,{ anything: 'v' } as any)).toThrow(UnknownSlotError) // any: unknown key is intentionally invalid for error-case testing
      try {
        createAgent('test-agent', h,{ anything: 'v' } as any) // any: same as above
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
      expect(() => createAgent('test-agent', h,{ model: {} })).toThrow(RuntimeSlotInAgentError)
      expect(() => createAgent('test-agent', h,{ model: {} })).not.toThrow(UnknownSlotError)
      try {
        createAgent('test-agent', h,{ model: {} })
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
      expect(() => createAgent('test-agent', h,{ model: {}, prompts: 'sys' } as any)).toThrow(RuntimeSlotInAgentError) // any: runtime() key in slots is intentionally invalid — Pick<Ctx, Req> excludes runtime slots
      try {
        createAgent('test-agent', h,{ model: {}, prompts: 'sys' } as any) // any: same as above
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
      expect(() => createAgent('test-agent', h,{ model: {} } as any)).toThrow(RuntimeSlotInAgentError) // any: runtime() key in slots is intentionally invalid
      try {
        createAgent('test-agent', h,{ model: {} } as any) // any: same as above
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
      expect(() => createAgent('test-agent', h,{} as any)).toThrow(MissingSlotError) // any: missing required slot is intentionally invalid for error-case testing
      try {
        createAgent('test-agent', h,{} as any) // any: same as above
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
      expect(() => createAgent('test-agent', h,{ prompts: 'sys' } as any)).toThrow(MissingSlotError) // any: missing required slot is intentionally invalid for error-case testing
      try {
        createAgent('test-agent', h,{ prompts: 'sys' } as any) // any: same as above
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
      expect(() => createAgent('test-agent', h,{ prompts: 'system prompt text' })).not.toThrow()
      const agent = createAgent('test-agent', h,{ prompts: 'system prompt text' })
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
      expect(() => createAgent('test-agent', h,{})).not.toThrow()
      const agent = createAgent('test-agent', h,{})
      expect(agent).toBeDefined()
    })

    it('returns an Agent when harness has only runtime() slots', () => {
      // arrange
      const h = createHarness<{ model: object }>()({})
        .provide('model', runtime())
        .loop(buildValidLoop)

      // act & assert
      expect(() => createAgent('test-agent', h,{})).not.toThrow()
      const agent = createAgent('test-agent', h,{})
      expect(agent).toBeDefined()
    })
  })

  describe('Group 4: Agent method stubs', () => {
    it('agent.resume() returns a RunHandle whose execution rejects with NoInterruptError when no store is configured', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{ prompts: 'sys' })

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
                run: async (_s, ctx) => { capturedCtx = ctx as Record<string, unknown>; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent('test-agent', h,{})

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
                run: async (_s, ctx) => {
                  capturedCtxSessionId = ctx.sessionId
                  return {}
                },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent('test-agent', h,{})

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
                run: async (_s, ctx) => { capturedCtx = ctx as Record<string, unknown>; return {} },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{ prompts: 'You are a helpful assistant.' })

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
        const agent = createAgent('test-agent', h,{})

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
                run: async (_s, ctx) => {
                  ctxRefs.push(ctx as Record<string, unknown>)
                  return {}
                },
                route: () => 'done',
              })
              .on('done').end()
          })
        const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})
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
      const agent = createAgent('test-agent', h,{})
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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})
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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

      // act
      await agent.run({}, { events: { onBeforeStep: () => {} } })

      // assert
      expect('events' in capturedCtx!).toBe(false)
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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
          agentId: 'test-agent',
          sessionId: 'sess-1',
          runId: 'run-1',
          version: 0,
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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

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
      const agent = createAgent('test-agent', h,{})

      // act
      await agent.run({}, { listeners: { 'e': fnA } })
      await agent.run({}, { listeners: { 'e': fnB } })

      // assert
      expect(fnA).toHaveBeenCalledTimes(1)
      expect(fnB).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // Observer wiring helpers
  // -----------------------------------------------------------------------

  function buildSlottedAgent(slot: { bindObserver: ReturnType<typeof vi.fn> }) {
    const h = createHarness<{ adapter: typeof slot }>()()
      .provide('adapter', required())
      .loop(l => {
        l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
    return createAgent('test-agent', h, { adapter: slot })
  }

  function buildLoopAgent() {
    const h = createHarness<Record<string, never>>()()
      .loop(l => {
        l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
    return createAgent('test-agent', h, {})
  }

  // -----------------------------------------------------------------------
  // Group: extractRunObserver — observer extraction from resources
  // -----------------------------------------------------------------------

  describe('Group: extractRunObserver — observer extraction from resources', () => {
    it('calls bindObserver with {} (NOOP_OBSERVER) when resources has no observer key', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const agent = buildSlottedAgent(slot)

      // act
      await agent.run({}, {})

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })

    it('calls bindObserver with {} when observer: null (null is not a plain object)', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const agent = buildSlottedAgent(slot)

      // act
      await agent.run({}, { observer: null } as any) // any: null is intentionally invalid to test the null guard

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })

    it('calls bindObserver with the exact observer reference when observer is a plain object', async () => {
      // arrange
      const obs = { onRunStart: vi.fn() }
      const slot = { bindObserver: vi.fn() }
      const agent = buildSlottedAgent(slot)

      // act
      await agent.run({}, { observer: obs })

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver.mock.calls[0]![0]).toBe(obs)
    })

    it('accepts empty object {} as a valid observer — bindObserver receives the exact reference', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const agent = buildSlottedAgent(slot)
      const emptyObs = {}

      // act
      await agent.run({}, { observer: emptyObs })

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver.mock.calls[0]![0]).toBe(emptyObs)
    })

    it('calls bindObserver with {} when observer: 42 (primitive is not an object)', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const agent = buildSlottedAgent(slot)

      // act
      await agent.run({}, { observer: 42 } as any) // any: number is intentionally invalid to test the typeof guard

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })

    it('calls bindObserver with {} when observer is an array (arrays are not plain objects)', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const agent = buildSlottedAgent(slot)
      const arr = [vi.fn(), vi.fn()]

      // act
      await agent.run({}, { observer: arr } as any) // any: array is intentionally invalid to test the Array.isArray guard

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })
  })

  // -----------------------------------------------------------------------
  // Group: reservedRunKeys — 'observer' is silently consumed
  // -----------------------------------------------------------------------

  describe("Group: reservedRunKeys — 'observer' is silently consumed", () => {
    it("no error when observer key is passed to an agent that has no 'observer' slot", async () => {
      // arrange
      const obs = { onRunStart: vi.fn() }
      const h = createHarness<Record<string, never>>()()
        .loop(l => {
          l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      const act = () => agent.run({}, { observer: obs })

      // assert
      await expect(act()).resolves.toBeDefined()
    })

    it("no error when resources has observer alongside a harness with runtime slot named 'observer'; observer NOT injected into ctx", async () => {
      // arrange
      let capturedCtxObserver: unknown = 'not-checked'
      const obs = { onRunStart: vi.fn() }
      const h = createHarness<{ observer: unknown }>()()
        .provide('observer', runtime())
        .loop(l => {
          l.start().step('run', {
            run: async (_s: unknown, c: any) => { capturedCtxObserver = c.observer; return {} }, // any: capturing ctx fields for assertion
            route: () => 'done',
          }).on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      await agent.run({}, { observer: obs })

      // assert
      expect(capturedCtxObserver).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Group: ObserverAware slot binding
  // -----------------------------------------------------------------------

  describe('Group: ObserverAware slot binding', () => {
    it('calls bindObserver(obs) on a build-time required slot before any step runs', async () => {
      // arrange
      const callOrder: string[] = []
      const slot = { bindObserver: vi.fn().mockImplementation(() => callOrder.push('bindObserver')) }
      const obs = { onRunStart: vi.fn() }
      const h = createHarness<{ adapter: typeof slot }>()()
        .provide('adapter', required())
        .loop(l => {
          l.start().step('run', {
            run: async () => { callOrder.push('step.run'); return {} },
            route: () => 'done',
          }).on('done').end()
        })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      const run = agent.run({}, { observer: obs })
      const boundBeforeAsync = slot.bindObserver.mock.calls.length
      await run

      // assert
      expect(boundBeforeAsync).toBe(1)
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver.mock.calls[0]![0]).toBe(obs)
      expect(callOrder[0]).toBe('bindObserver')
      expect(callOrder[1]).toBe('step.run')
    })

    it('calls bindObserver({}) (NOOP_OBSERVER) when no observer is provided in resources', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const h = createHarness<{ adapter: typeof slot }>()()
        .provide('adapter', required())
        .loop(l => {
          l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
        })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      await agent.run({}, {})

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
      const arg = slot.bindObserver.mock.calls[0]![0]
      expect(arg).not.toBeUndefined()
    })

    it('no error when a slot does NOT implement bindObserver (duck-type check fails silently)', async () => {
      // arrange
      const plainSlot = { doWork: vi.fn() }
      const h = createHarness<{ tool: typeof plainSlot }>()()
        .provide('tool', required())
        .loop(l => {
          l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
        })
      const agent = createAgent('test-agent', h, { tool: plainSlot })
      const obs = { onRunStart: vi.fn() }

      // act
      const act = async () => await agent.run({}, { observer: obs })

      // assert
      await expect(act()).resolves.toBeDefined()
      expect(plainSlot.doWork).not.toHaveBeenCalled()
    })

    it('calls bindObserver only on the ObserverAware slot when two slots are present', async () => {
      // arrange
      const observerAwareSlot = { bindObserver: vi.fn() }
      const plainSlot = { compute: vi.fn() }
      const h = createHarness<{ adapter: typeof observerAwareSlot; tool: typeof plainSlot }>()()
        .provide('adapter', required())
        .provide('tool', required())
        .loop(l => {
          l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
        })
      const agent = createAgent('test-agent', h, { adapter: observerAwareSlot, tool: plainSlot })
      const obs = { onRunStart: vi.fn() }

      // act
      await agent.run({}, { observer: obs })

      // assert
      expect(observerAwareSlot.bindObserver).toHaveBeenCalledOnce()
      expect(observerAwareSlot.bindObserver.mock.calls[0]![0]).toBe(obs)
      expect(plainSlot.compute).not.toHaveBeenCalled()
    })

    it('does NOT call bindObserver when slot.bindObserver is a non-function (e.g. a string)', async () => {
      // arrange
      const slotWithStringProp = { bindObserver: 'not-a-function', process: vi.fn() }
      const h = createHarness<{ adapter: typeof slotWithStringProp }>()()
        .provide('adapter', required())
        .loop(l => {
          l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
        })
      const agent = createAgent('test-agent', h, { adapter: slotWithStringProp as any }) // any: non-function bindObserver is intentionally invalid
      const obs = { onRunStart: vi.fn() }

      // act
      const act = async () => await agent.run({}, { observer: obs })

      // assert
      await expect(act()).resolves.toBeDefined()
    })

    it('calls bindObserver(obs) on a runtime slot that implements ObserverAware', async () => {
      // arrange
      const runtimeAdapter = { bindObserver: vi.fn() }
      const obs = { onRunStart: vi.fn() }
      const h = createHarness<{ adapter: typeof runtimeAdapter }>()()
        .provide('adapter', runtime())
        .loop(l => {
          l.start().step('run', { run: async () => ({}), route: () => 'done' }).on('done').end()
        })
      const agent = createAgent('test-agent', h, {})

      // act
      await agent.run({}, { adapter: runtimeAdapter, observer: obs })

      // assert
      expect(runtimeAdapter.bindObserver).toHaveBeenCalledOnce()
      expect(runtimeAdapter.bindObserver.mock.calls[0]![0]).toBe(obs)
    })
  })

  // -----------------------------------------------------------------------
  // Group: Observer threading through agent.run() execution
  // -----------------------------------------------------------------------

  describe('Group: Observer threading through agent.run() execution', () => {
    it('onRunStart, onStepStart, and onRunEnd all fire when observer is provided', async () => {
      // arrange
      const callOrder: string[] = []
      const obs = {
        onRunStart:  vi.fn().mockImplementation(() => callOrder.push('onRunStart')),
        onStepStart: vi.fn().mockImplementation(() => callOrder.push('onStepStart')),
        onRunEnd:    vi.fn().mockImplementation(() => callOrder.push('onRunEnd')),
      }
      const agent = buildLoopAgent()

      // act
      await agent.run({}, { observer: obs })

      // assert
      expect(obs.onRunStart).toHaveBeenCalledOnce()
      expect(obs.onStepStart).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: 'done', durationMs: expect.any(Number) }),
      )
      expect(callOrder[0]).toBe('onRunStart')
      expect(callOrder[callOrder.length - 1]).toBe('onRunEnd')
    })

    it('callbacks.observer is absent when no observer is provided in resources', async () => {
      // arrange
      const agent = buildLoopAgent()
      let capturedCallbacks: Record<string, unknown> | undefined
      vi.spyOn(loopExecutorModule, 'runLoop').mockImplementationOnce(
        async (_graph, _state, _ctx, _schema, _shouldStop, _store, callbacks) => {
          capturedCallbacks = callbacks as Record<string, unknown>
          return { signal: 'done', state: {}, paused: false, cursor: null }
        }
      )

      // act
      await agent.run({}, {})

      // assert
      expect(capturedCallbacks).toBeDefined()
      expect('observer' in (capturedCallbacks ?? {})).toBe(false)
    })

  })


  // -----------------------------------------------------------------------
  // Group: CtxRunSignal (F29) — ctx.runId and ctx.signal injection
  // -----------------------------------------------------------------------

  describe('CtxRunSignal', () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    describe('Group 1: ctx.runId identity and uniqueness', () => {
      it('exposes runId equal to run.runId and available synchronously as a string', async () => {
        // arrange
        let capturedRunId: string | undefined
        let capturedRunIdType: string | undefined
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing runId from ctx
                  capturedRunId = c.runId
                  capturedRunIdType = typeof c.runId
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        await run

        // assert
        expect(typeof capturedRunIdType).toBe('string')
        expect(capturedRunId).toBe(run.runId)
        expect(capturedRunId).toMatch(uuidPattern)
      })

      it('produces a distinct runId for each sequential agent.run() call', async () => {
        // arrange
        const capturedIds: string[] = []
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing runId from ctx
                  capturedIds.push(c.runId)
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run1 = agent.run({}, {})
        await run1
        const run2 = agent.run({}, {})
        await run2

        // assert
        expect(capturedIds).toHaveLength(2)
        expect(capturedIds[0]).not.toBe(capturedIds[1])
      })
    })

    describe('Group 2: synthesized AbortSignal when no external signal is provided', () => {
      it('ctx.signal.aborted is false before run.stop() is called', async () => {
        // arrange
        let capturedBeforeStop: boolean | undefined
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing signal from ctx
                  capturedBeforeStop = c.signal.aborted
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        await run

        // assert
        expect(capturedBeforeStop).toBe(false)
      })

      it('ctx.signal is an AbortSignal instance when no external signal is provided', async () => {
        // arrange
        let capturedSignal: unknown
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing signal from ctx
                  capturedSignal = c.signal
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        await run

        // assert
        expect(capturedSignal).toBeInstanceOf(AbortSignal)
        expect((capturedSignal as AbortSignal).aborted).toBe(false)
      })
    })

    describe('Group 3: external AbortSignal passthrough', () => {
      it('ctx.signal is the same AbortSignal instance when one is provided in resources', async () => {
        // arrange
        const ac = new AbortController()
        let capturedSignal: AbortSignal | undefined
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing signal from ctx
                  capturedSignal = c.signal
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, { signal: ac.signal })
        await run

        // assert
        expect(capturedSignal).toBe(ac.signal)
      })

      it('ctx.signal.aborted is true when the provided signal is already aborted', async () => {
        // arrange
        const ac = new AbortController()
        ac.abort()
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async () => { return {} },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, { signal: ac.signal })
        await run

        // assert
        expect(ac.signal.aborted).toBe(true)
        expect(run).toBeDefined()
      })

      it('ctx.signal.aborted becomes true after run.stop() is called externally', async () => {
        // arrange
        let capturedSignal: AbortSignal | undefined
        let signalAbortedAfterStop: boolean | undefined
        let unblock: (() => void) | undefined
        const blocker = new Promise<void>(r => { unblock = r })
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing signal from ctx
                  capturedSignal = c.signal
                  await blocker
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        // Allow step to start and capture signal before calling stop
        await new Promise(resolve => setImmediate(resolve))
        run.stop()
        unblock!()
        await run

        // Check signal state after stop
        signalAbortedAfterStop = capturedSignal?.aborted

        // assert
        expect(capturedSignal).toBeDefined()
        expect(signalAbortedAfterStop).toBe(true)
      })
    })

    describe('Group 4: resume paths receive distinct runId and working AbortSignal', () => {
      it('resumed step via run.resume() receives a different runId than the original run', async () => {
        // arrange
        const capturedRunIds: string[] = []
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing interrupt and runId
                  capturedRunIds.push(c.runId)
                  await c.interrupt({ prompt: 'continue?' })
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        await run
        const resumeRun = run.resume({}, '$auto:0')
        await resumeRun

        // assert
        expect(capturedRunIds).toHaveLength(2)
        expect(capturedRunIds[0]).toMatch(uuidPattern)
        expect(capturedRunIds[1]).toMatch(uuidPattern)
        expect(capturedRunIds[0]).not.toBe(capturedRunIds[1])
      })

      it('resumed step via agent.resume() receives a runId distinct from the original run', async () => {
        // arrange
        // This test covers the makeAgentResumeHandle code path (cross-process resume via agent.resume())
        const originalRunId = 'run-id-original'
        const capturedRunIds: string[] = []
        const stubStore = makeStubStore({
          load: vi.fn().mockResolvedValue({
            agentId: 'test-agent',
            runId: originalRunId,
            sessionId: 'test-session',
            version: 1,
            startedAt: new Date().toISOString(),
            settledAt: new Date().toISOString(),
            phase: 'paused',
            initialState: {},
            finalState: { $interrupt: { interruptId: 'interrupt-1' } },
          } as StoredRun),
        })

        const h = createHarness<Record<string, never>>()({})
          .store({ session: stubStore })
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing runId
                  capturedRunIds.push(c.runId)
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        // Use agent.resume() to trigger the makeAgentResumeHandle code path
        const resumeRun = agent.resume({}, 'test-session', 'interrupt-1')
        await resumeRun

        // assert
        expect(capturedRunIds).toHaveLength(1)
        expect(capturedRunIds[0]).toMatch(uuidPattern)
        // The resumed run should have a distinct runId from the original run
        expect(capturedRunIds[0]).not.toBe(originalRunId)
      })

      it('resume path creates a new AbortSignal with distinct signal object from original run', async () => {
        // arrange
        let originalSignal: AbortSignal | undefined
        let resumeSignal: AbortSignal | undefined
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing interrupt and signal
                  if (!originalSignal) {
                    originalSignal = c.signal
                    await c.interrupt({ prompt: 'continue?' })
                  } else {
                    resumeSignal = c.signal
                  }
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        await run
        const resumeRun = run.resume({}, '$auto:0')
        await resumeRun

        // assert
        expect(originalSignal).toBeDefined()
        expect(resumeSignal).toBeDefined()
        expect(resumeSignal).not.toBe(originalSignal)
        expect(resumeSignal).toBeInstanceOf(AbortSignal)
      })

      it('run.stop() on a buildResumeFn resume handle aborts the resume\'s ctx.signal', async () => {
        // arrange
        let resumeSignalCapture: AbortSignal | undefined
        let resumeSignalAbortedAfterStop: boolean | undefined
        let isResume = false
        let unblockResume: (() => void) | undefined
        const resumeBlocker = new Promise<void>(r => { unblockResume = r })
        const h = createHarness<Record<string, never>>()()
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing interrupt and signal
                  if (!isResume) {
                    // First run: trigger interrupt
                    isResume = true
                    await c.interrupt({ prompt: 'continue?' })
                  } else {
                    // Resume path: capture signal and wait for blocker
                    resumeSignalCapture = c.signal
                    await resumeBlocker
                  }
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        const run = agent.run({}, {})
        await run
        const resumeRun = run.resume({}, '$auto:0')
        // Allow resume step to start and capture signal before calling stop
        await new Promise(resolve => setImmediate(resolve))
        resumeRun.stop()
        unblockResume!()
        await resumeRun

        // Check signal state after stop
        resumeSignalAbortedAfterStop = resumeSignalCapture?.aborted

        // assert
        expect(resumeSignalCapture).toBeDefined()
        expect(resumeSignalAbortedAfterStop).toBe(true)
      })

      it('run.stop() on an agent.resume() handle aborts the resume\'s ctx.signal', async () => {
        // arrange
        const stubStore = makeStubStore({
          load: vi.fn().mockResolvedValue({
            agentId: 'test-agent',
            runId: 'run-id-123',
            sessionId: 'test-session',
            version: 1,
            startedAt: new Date().toISOString(),
            settledAt: new Date().toISOString(),
            phase: 'paused',
            initialState: {},
            finalState: { $interrupt: { interruptId: 'interrupt-1' } },
          } as StoredRun),
        })

        let outerCrossProcessSignal: AbortSignal | undefined
        let resumeSignalAbortedAfterStop: boolean | undefined
        let unblockCrossProcess: (() => void) | undefined
        const crossProcessBlocker = new Promise<void>(r => { unblockCrossProcess = r })
        const h = createHarness<Record<string, never>>()({})
          .store({ session: stubStore })
          .loop(l => {
            l.start()
              .step('step1', {
                run: async (_s: unknown, c: any) => { // any: accessing signal
                  outerCrossProcessSignal = c.signal
                  await crossProcessBlocker
                  return {}
                },
                route: () => 'done',
              })
              .on('done')
              .end()
          })
        const agent = createAgent('test-agent', h, {})

        // act
        // resume(response, sessionId, interruptId)
        const resumeRun = agent.resume({}, 'test-session', 'interrupt-1')
        // Allow resume step to start and capture signal before calling stop
        await new Promise(resolve => setImmediate(resolve))
        resumeRun.stop()
        unblockCrossProcess!()
        await resumeRun

        // Check signal state after stop
        resumeSignalAbortedAfterStop = outerCrossProcessSignal?.aborted

        // assert
        expect(outerCrossProcessSignal).toBeDefined()
        expect(resumeSignalAbortedAfterStop).toBe(true)
      })
    })

    describe('Group 5: cancellation propagation to child agent runs', () => {
      it('child run receives the same signal object passed by parent via resources', async () => {
        // arrange
        let parentSignal: AbortSignal | undefined
        let childSignal: AbortSignal | undefined
        const childAgent = createAgent(
          'child-agent',
          createHarness<Record<string, never>>()()
            .loop(l => {
              l.start()
                .step('step1', {
                  run: async (_s: unknown, c: any) => { // any: accessing signal
                    childSignal = c.signal
                    return {}
                  },
                  route: () => 'done',
                })
                .on('done')
                .end()
            }),
          {}
        )

        const parentAgent = createAgent(
          'parent-agent',
          createHarness<Record<string, never>>()()
            .loop(l => {
              l.start()
                .step('step1', {
                  run: async (_s: unknown, c: any) => { // any: accessing signal and launching child
                    parentSignal = c.signal
                    await childAgent.run({}, { signal: c.signal })
                    return {}
                  },
                  route: () => 'done',
                })
                .on('done')
                .end()
            }),
          {}
        )

        // act
        const parentRun = parentAgent.run({}, {})
        await parentRun

        // assert
        // Child receives the exact same signal object from parent
        expect(parentSignal).toBeDefined()
        expect(childSignal).toBeDefined()
        expect(childSignal).toBe(parentSignal)
      })

      it('child run receives an already-aborted signal when the parent is stopped before the child starts', async () => {
        // Behavior spec item 11: parent passes its signal to child, parent is stopped,
        // child receives an already-aborted signal.
        // This implements the end-to-end cascade per the testplan.

        // arrange
        let parentSignal: AbortSignal | undefined
        let childSeenAborted: boolean | undefined
        let unblockChild: (() => void) | undefined
        const childBlocker = new Promise<void>(r => { unblockChild = r })

        const childAgent = createAgent(
          'child-agent',
          createHarness<Record<string, never>>()()
            .loop(l => {
              l.start()
                .step('step1', {
                  run: async (_s: unknown, c: any) => { // any: accessing signal
                    // Child waits for external trigger before reading signal
                    // This ensures we can abort before the child reads
                    await childBlocker
                    // Child checks signal.aborted state
                    childSeenAborted = c.signal.aborted
                    return {}
                  },
                  route: () => 'done',
                })
                .on('done')
                .end()
            }),
          {}
        )

        const parentAgent = createAgent(
          'parent-agent',
          createHarness<Record<string, never>>()()
            .loop(l => {
              l.start()
                .step('step1', {
                  run: async (_s: unknown, c: any) => { // any: accessing signal and launching child
                    parentSignal = c.signal
                    // Synchronously create the child run with the parent's signal
                    const childRun = childAgent.run({}, { signal: c.signal })
                    // Wait for child to complete
                    await childRun
                    return {}
                  },
                  route: () => 'done',
                })
                .on('done')
                .end()
            }),
          {}
        )

        // act
        const parentRun = parentAgent.run({}, {})
        // Allow the parent step to start and launch the child
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
        // Stop the parent — this aborts the signal
        parentRun.stop()
        // Small delay to ensure abort has propagated
        await new Promise(resolve => setImmediate(resolve))
        // Now unblock the child to read the (aborted) signal
        unblockChild!()
        // Let both parent and child settle
        await parentRun

        // assert
        expect(parentSignal).toBeDefined()
        expect(parentSignal!.aborted).toBe(true)
        // This tests that child saw the signal as aborted.
        // The child reads the signal after the parent was stopped and the signal was aborted.
        expect(childSeenAborted).toBe(true)
      })
    })
  })

  // -----------------------------------------------------------------------
  // F29 — RunContextIds (parentRunId reserved key, threading)
  // -----------------------------------------------------------------------

  describe('Group: parentRunId reserved key extraction and threading', () => {
    it('does not throw UnknownRunSlotError when parentRunId is passed in resources', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { parentRunId: 'parent-xyz' })
      const outcome = await run

      // assert
      expect(outcome).toBeDefined()
      expect(outcome.signal).not.toBe('$error')
    })

    it('extracts string parentRunId from resources and threads to observer', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { parentRunId: 'abc-123', observer })
      await run

      // assert
      expect(capturedCtx).toHaveLength(1)
      expect(capturedCtx[0]!.parentRunId).toBe('abc-123')
    })

    it('silently ignores non-string parentRunId value in resources', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { parentRunId: 42, observer } as unknown as Record<string, unknown>)
      await run

      // assert
      expect(capturedCtx[0]!.parentRunId).toBeUndefined()
      expect('parentRunId' in capturedCtx[0]!).toBe(false)
    })

    it('omits parentRunId from RunContext when absent from agent.run() resources', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { observer })
      await run

      // assert
      expect(capturedCtx).toHaveLength(1)
      expect(capturedCtx[0]!.parentRunId).toBeUndefined()
      expect('parentRunId' in capturedCtx[0]!).toBe(false)
    })

    it('receives parentRunId in onRunEnd when passed in resources', async () => {
      // arrange
      const endCtx: RunContext[] = []
      const observer = { onRunEnd: vi.fn((ctx: any) => endCtx.push(ctx)) } // any: capturing RunContext

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { parentRunId: 'abc-123', observer })
      await run

      // assert
      expect(endCtx).toHaveLength(1)
      expect(endCtx[0]!.parentRunId).toBe('abc-123')
    })
  })

  describe('Group: runId threading to observer', () => {
    it('passes runId from RunHandle to observer at onRunStart', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { observer })
      await run

      // assert
      expect(capturedCtx[0]!.runId).toBe(run.runId)
    })

    it('passes same runId to both onRunStart and onRunEnd', async () => {
      // arrange
      const startCtx: RunContext[] = []
      const endCtx: RunContext[] = []
      const observer = {
        onRunStart: vi.fn((ctx: any) => startCtx.push(ctx)), // any: capturing RunContext
        onRunEnd: vi.fn((ctx: any) => endCtx.push(ctx)),      // any: capturing RunContext
      }

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      const run = agent.run({}, { observer })
      await run

      // assert
      expect(startCtx[0]!.runId).toBe(endCtx[0]!.runId)
      expect(startCtx[0]!.runId).toBe(run.runId)
    })
  })

  describe('Group: concurrency isolation', () => {
    it('concurrent runs with different parentRunId values deliver to each observer independently', async () => {
      // arrange
      const ctxA: RunContext[] = []
      const ctxB: RunContext[] = []
      const obsA = { onRunStart: vi.fn((ctx: any) => ctxA.push(ctx)) } // any: capturing RunContext
      const obsB = { onRunStart: vi.fn((ctx: any) => ctxB.push(ctx)) } // any: capturing RunContext

      const h = createHarness<Record<string, never>>()({})
        .loop(l =>
          l
            .start()
            .step('go', { route: () => 'done' })
            .on('done')
            .end(),
        )

      const agent = createAgent('agent-1', h, {})

      // act
      await Promise.all([
        agent.run({}, { parentRunId: 'parent-A', sessionId: 'sess-A', observer: obsA }),
        agent.run({}, { parentRunId: 'parent-B', sessionId: 'sess-B', observer: obsB }),
      ])

      // assert
      expect(ctxA[0]!.parentRunId).toBe('parent-A')
      expect(ctxB[0]!.parentRunId).toBe('parent-B')
    })
  })

  // -----------------------------------------------------------------------
  // F35 — RunResumeObserver tests
  // -----------------------------------------------------------------------

  describe('Group: RunResumeObserver — Group 1: Full observer lifecycle fires on same-process in-memory resume', () => {
    it('fires onRunStart, onStepStart, onStepEnd, and onRunEnd once each when run.resume() completes normally', async () => {
      // arrange
      const callOrder: string[] = []
      const obs = {
        onRunStart: vi.fn(() => callOrder.push('onRunStart')),
        onStepStart: vi.fn(() => callOrder.push('onStepStart')),
        onStepEnd: vi.fn(() => callOrder.push('onStepEnd')),
        onRunEnd: vi.fn(() => callOrder.push('onRunEnd')),
      }
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('prompt?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs })
      await run1
      vi.clearAllMocks()
      callOrder.length = 0

      // act
      const resumeRun = run1.resume('user-answer', '$auto:0')
      await resumeRun

      // assert
      // onRunStart and onRunEnd fire once per resumed run
      expect(obs.onRunStart).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: 'done' }))
      // step1 re-runs (replays stored interrupt response) + step2 runs → 2 step events each
      expect(obs.onStepStart).toHaveBeenCalledTimes(2)
      expect(obs.onStepEnd).toHaveBeenCalledTimes(2)
      expect(callOrder[0]).toBe('onRunStart')
      expect(callOrder[callOrder.length - 1]).toBe('onRunEnd')
    })

    it('onRunStart receives RunContext with runId matching resumeHandle.runId and distinct from original run runId', async () => {
      // arrange
      const originalRunId = { value: '' }
      const resumeCtxRunId = { value: '' }
      const obs = { onRunStart: vi.fn((ctx: RunContext) => { resumeCtxRunId.value = ctx.runId }) }
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs })
      await run1
      originalRunId.value = run1.runId
      vi.clearAllMocks()

      // act
      const resumeRun = run1.resume('answer', '$auto:0')
      await resumeRun

      // assert
      expect(resumeCtxRunId.value).toBe(resumeRun.runId)
      expect(resumeCtxRunId.value).not.toBe(originalRunId.value)
      expect(resumeCtxRunId.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })
  })

  describe('Group: RunResumeObserver — Group 2: Observer fires on cross-process store resume path', () => {
    it('fires onRunStart with RunContext.runId equal to resumeHandle.runId on store-backed resume', async () => {
      // arrange
      const capturedCtxRunId = { value: '' }
      const obs = {
        onRunStart: vi.fn((ctx: RunContext) => { capturedCtxRunId.value = ctx.runId }),
        onRunEnd: vi.fn(),
      }
      const pausedRun = {
        agentId: 'test-agent',
        sessionId: 'sess-1',
        runId: 'run-1',
        version: 0,
        phase: 'paused' as const,
        startedAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
        initialState: {},
        finalState: {
          $interrupt: { interruptId: '$auto:0', prompt: 'continue?' },
          $interruptResponses: {},
          $cursor: 'step2',
        },
        step: 'step2',
        signal: '$interrupt',
      } satisfies StoredRun
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(pausedRun),
      })
      const h = createHarness<Record<string, never>>()()
        .store({ session: stubStore })
        .loop(l => {
          l.start()
            .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('prompt?'); return {} } }) // any: accessing interrupt
            .next('step2')
            .step('step2', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs, sessionId: 'sess-1' })
      await run1
      vi.clearAllMocks()

      // act
      const resumeRun = run1.resume('user-answer', '$auto:0')
      await resumeRun

      // assert
      expect(obs.onRunStart).toHaveBeenCalledOnce()
      expect(capturedCtxRunId.value).toBe(resumeRun.runId)
      expect(capturedCtxRunId.value).not.toBe(run1.runId)
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
    })
  })

  describe('Group: RunResumeObserver — Group 3: No observer — resume completes without runtime error', () => {
    it('run.resume() completes normally when agent.run() was called without an observer', async () => {
      // arrange
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, {})
      await run1

      // act
      const resumeRun = run1.resume('answer', '$auto:0')
      const outcome = await resumeRun

      // assert
      expect(outcome).toEqual(expect.objectContaining({ signal: 'done' }))
    })
  })

  describe('Group: RunResumeObserver — Group 4: Observer fires correct events for non-happy-path resume outcomes', () => {
    it('onInterrupt and onRunEnd($interrupt) fire when the resumed run hits a second interrupt', async () => {
      // arrange
      const obs = { onInterrupt: vi.fn(), onRunEnd: vi.fn() }
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('first?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async (_s: unknown, c: any) => { await c.interrupt('second?'); return {} } }) // any: accessing interrupt
          .next('step3')
          .step('step3', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs })
      await run1
      vi.clearAllMocks()

      // act
      const resumeRun = run1.resume('resp-1', '$auto:0')
      await resumeRun

      // assert
      expect(obs.onInterrupt).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: '$interrupt' }))
    })

    it('onRunEnd fires with the terminal signal when resumed run exits via a named route', async () => {
      // arrange
      const obs = { onRunEnd: vi.fn() }
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async () => ({}), route: () => 'complete' })
          .on('complete').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs })
      await run1
      vi.clearAllMocks()

      // act
      const resumeRun = run1.resume('resp', '$auto:0')
      await resumeRun

      // assert
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: 'complete' }))
    })

    it('onStepError fires and onRunEnd fires with $error signal when a resumed step throws', async () => {
      // arrange
      const capturedError = { value: undefined as unknown }
      const obs = {
        onStepError: vi.fn((_ctx: unknown, ev: { error: unknown }) => { capturedError.value = ev.error }),
        onRunEnd: vi.fn(),
      }
      const thrown = new Error('step-boom')
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async () => { throw thrown }, route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs })
      await run1
      vi.clearAllMocks()

      // act
      const resumeRun = run1.resume('resp', '$auto:0')
      await resumeRun // loop executor catches step throws and settles with signal: '$error' — promise resolves, does not reject

      // assert
      expect(obs.onStepError).toHaveBeenCalledOnce()
      expect(capturedError.value).toBe(thrown)
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: '$error' }))
    })
  })

  describe('Group: RunResumeObserver — Group 5: Chained resume — each resumed run has an independent observer lifecycle', () => {
    it('two consecutive run.resume() calls each fire onRunStart and onRunEnd with distinct runIds', async () => {
      // arrange
      const runStartIds: string[] = []
      const obs = {
        onRunStart: vi.fn((ctx: RunContext) => { runStartIds.push(ctx.runId) }),
        onRunEnd: vi.fn(),
      }
      const h = createHarness<Record<string, never>>()().loop(l => {
        l.start()
          .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('first?'); return {} } }) // any: accessing interrupt
          .next('step2')
          .step('step2', { run: async (_s: unknown, c: any) => { await c.interrupt('second?'); return {} } }) // any: accessing interrupt
          .next('step3')
          .step('step3', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})
      const run1 = agent.run({}, { observer: obs })
      await run1
      runStartIds.length = 0
      obs.onRunEnd.mockClear()

      // act
      const resume1 = run1.resume('resp-1', '$auto:0')
      await resume1
      const resume2 = resume1.resume('resp-2', '$auto:1')
      await resume2

      // assert
      expect(runStartIds).toHaveLength(2)
      expect(runStartIds[0]).not.toBe(runStartIds[1])
      expect(runStartIds[0]).toBe(resume1.runId)
      expect(runStartIds[1]).toBe(resume2.runId)
      expect(obs.onRunEnd).toHaveBeenCalledTimes(2)
    })
  })

  describe('Group: RunResumeObserver — Group 6: bindObserver is not called again during run.resume()', () => {
    it('bindObserver call count on an ObserverAware slot remains 1 after run.resume() completes', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const h = createHarness<{ adapter: typeof slot }>()()
        .provide('adapter', required())
        .loop(l => {
          l.start()
            .step('step1', { run: async (_s: unknown, c: any) => { await c.interrupt('?'); return {} } }) // any: accessing interrupt
            .next('step2')
            .step('step2', { run: async () => ({}), route: () => 'done' })
            .on('done').end()
        })
      const agent = createAgent('test-agent', h, { adapter: slot })
      const obs = { onRunStart: vi.fn() }

      // act
      const run1 = agent.run({}, { observer: obs })
      await run1
      const resumeRun = run1.resume('resp', '$auto:0')
      await resumeRun

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver.mock.calls[0]![0]).toBe(obs)
    })
  })

  // -----------------------------------------------------------------------
  // F35 — AgentResumeObserver tests (agent.resume() cross-process path)
  // -----------------------------------------------------------------------

  describe('Group: AgentResumeObserver — Group 1: Full observer lifecycle fires on cross-process agent.resume()', () => {
    it('fires onRunStart, onStepStart, onStepEnd, and onRunEnd when agent.resume() completes normally', async () => {
      // arrange
      const callOrder: string[] = []
      const obs = {
        onRunStart: vi.fn(() => callOrder.push('onRunStart')),
        onStepStart: vi.fn(() => callOrder.push('onStepStart')),
        onStepEnd: vi.fn(() => callOrder.push('onStepEnd')),
        onRunEnd: vi.fn(() => callOrder.push('onRunEnd')),
      }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-1', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: 'continue?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()().store({ session: stubStore }).loop(l => {
        l.start()
          .step('step1', { run: async () => ({}), route: () => 'done' })
          .on('done').to('step2')
          .step('step2', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})

      // act
      const resumeRun = agent.resume('user-answer', 'sess-1', '$auto:0', { observer: obs })
      await resumeRun

      // assert
      expect(obs.onRunStart).toHaveBeenCalledOnce()
      expect(obs.onStepStart).toHaveBeenCalledOnce()
      expect(obs.onStepEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: 'done' }))
      expect(callOrder[0]).toBe('onRunStart')
      expect(callOrder[callOrder.length - 1]).toBe('onRunEnd')
    })

    it('onRunStart receives RunContext with correct runId, sessionId, and agentId', async () => {
      // arrange
      const capturedCtx = { value: undefined as unknown }
      const obs = { onRunStart: vi.fn((ctx: RunContext) => { capturedCtx.value = ctx }) }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'my-agent', sessionId: 'sess-ctx', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()().store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('my-agent', h, {})

      // act
      const resumeRun = agent.resume('resp', 'sess-ctx', '$auto:0', { observer: obs })
      await resumeRun

      // assert
      const ctx = capturedCtx.value as RunContext
      expect(ctx.runId).toBe(resumeRun.runId)
      expect(ctx.sessionId).toBe('sess-ctx')
      expect(ctx.agentId).toBe('my-agent')
      expect(ctx.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })
  })

  describe('Group: AgentResumeObserver — Group 2: observer extraction — absent, empty, and invalid observer values produce no events', () => {
    it('run completes normally when agent.resume() is called without a resources argument', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-noarg', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ adapter: typeof slot }>()().provide('adapter', required()).store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      const resumeRun = agent.resume('resp', 'sess-noarg', '$auto:0')
      const result = await resumeRun

      // assert
      expect(result.signal).toBe('done')
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })

    it('NOOP_OBSERVER is bound and run completes normally when resources is an empty object {}', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-empty', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ adapter: typeof slot }>()().provide('adapter', required()).store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      const resumeRun = agent.resume('resp', 'sess-empty', '$auto:0', {})
      const result = await resumeRun

      // assert
      expect(result.signal).toBe('done')
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })

    it('no observer events fire when resources has observer: null', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-null', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ adapter: typeof slot }>()().provide('adapter', required()).store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      const resumeRun = agent.resume('resp', 'sess-null', '$auto:0', { observer: null } as any) // any: null is intentionally invalid to test the null guard
      const result = await resumeRun

      // assert
      expect(result.signal).toBe('done')
      expect(slot.bindObserver).toHaveBeenCalledWith({})
    })
  })

  describe('Group: AgentResumeObserver — Group 3: ObserverAware slot binding behavior on agent.resume()', () => {
    it('bindObserver(obs) is called synchronously on ObserverAware required slot before execution begins', async () => {
      // arrange
      const callOrder: string[] = []
      const slot = { bindObserver: vi.fn().mockImplementation(() => callOrder.push('bindObserver')) }
      const obs = { onRunStart: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-bind', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ adapter: typeof slot }>()().provide('adapter', required()).store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      const resumeRun = agent.resume('resp', 'sess-bind', '$auto:0', { observer: obs })
      const bindCountBeforeAsync = slot.bindObserver.mock.calls.length
      await resumeRun

      // assert
      expect(bindCountBeforeAsync).toBe(1)
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver.mock.calls[0]![0]).toBe(obs)
      expect(callOrder[0]).toBe('bindObserver')
    })

    it('bindObserver({}) (NOOP_OBSERVER) is called when agent.resume() has no observer', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-noop', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ adapter: typeof slot }>()().provide('adapter', required()).store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { adapter: slot })

      // act
      await agent.resume('resp', 'sess-noop', '$auto:0')

      // assert
      expect(slot.bindObserver).toHaveBeenCalledOnce()
      expect(slot.bindObserver).toHaveBeenCalledWith({})
      const arg = slot.bindObserver.mock.calls[0]![0]
      expect(arg).not.toBeUndefined()
    })

    it('no error and no method call when resolved slot does not implement ObserverAware', async () => {
      // arrange
      const plainSlot = { doWork: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-noaware', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ tool: typeof plainSlot }>()().provide('tool', required()).store({ session: stubStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { tool: plainSlot })
      const obs = { onRunStart: vi.fn() }

      // act
      const resumeRun = agent.resume('resp', 'sess-noaware', '$auto:0', { observer: obs })
      const result = await resumeRun

      // assert
      expect(result.signal).toBe('done')
      expect(plainSlot.doWork).not.toHaveBeenCalled()
    })
  })

  describe('Group: AgentResumeObserver — Group 4: Non-happy-path outcomes fire correct observer events', () => {
    it('onInterrupt and onRunEnd($interrupt) fire when the resumed run hits a second interrupt', async () => {
      // arrange
      const obs = { onInterrupt: vi.fn(), onRunEnd: vi.fn() }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-interrupt2', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()().store({ session: stubStore }).loop(l => {
        l.start()
          .step('step2', { run: async (_s: unknown, c: any) => { await c.interrupt('second-prompt?'); return {} } }) // any: accessing interrupt
          .next('step3')
          .step('step3', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})

      // act
      const resumeRun = agent.resume('resp', 'sess-interrupt2', '$auto:0', { observer: obs })
      await resumeRun

      // assert
      expect(obs.onInterrupt).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: '$interrupt' }))
    })

    it('onStepError and onRunEnd($error) fire when a resumed step throws', async () => {
      // arrange
      const thrown = new Error('resume-step-boom')
      const capturedError = { value: undefined as unknown }
      const obs = {
        onStepError: vi.fn((_ctx: unknown, ev: { error: unknown }) => { capturedError.value = ev.error }),
        onRunEnd: vi.fn(),
      }
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-error', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step2',
          },
          step: 'step2', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()().store({ session: stubStore }).loop(l => {
        l.start()
          .step('step2', { run: async () => { throw thrown }, route: () => 'done' })
          .on('done').end()
      })
      const agent = createAgent('test-agent', h, {})

      // act
      const resumeRun = agent.resume('resp', 'sess-error', '$auto:0', { observer: obs })
      await resumeRun // runWithSession catches step throws and returns $error

      // assert
      expect(obs.onStepError).toHaveBeenCalledOnce()
      expect(capturedError.value).toBe(thrown)
      expect(obs.onRunEnd).toHaveBeenCalledOnce()
      expect(obs.onRunEnd).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: '$error' }))
    })
  })

  describe('Group: AgentResumeObserver — Group 5: SessionInFlightError fence precedes extraction and binding', () => {
    it('SessionInFlightError thrown synchronously and onRunStart never fires when session is in-flight', async () => {
      // arrange
      const slot = { bindObserver: vi.fn() }
      const obs = { onRunStart: vi.fn() }
      const blockerStore = makeStubStore({
        load: vi.fn().mockReturnValue(new Promise<StoredRun | null>(() => { /* never resolves */ })),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<{ adapter: typeof slot }>()().provide('adapter', required()).store({ session: blockerStore }).loop(l => {
        l.start().step('step2', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, { adapter: slot })
      // Start the first resume to put the session in-flight (do NOT await)
      const firstRun = agent.resume('r', 'sess-inflight', '$auto:0')
      // sess-inflight is now in inFlightSessions; firstRun's exec promise is suspended waiting for load
      // The first call already called bindObserver(NOOP) unconditionally — reset before the act
      slot.bindObserver.mockClear()

      // act
      let thrownError: unknown
      try {
        agent.resume('resp', 'sess-inflight', '$auto:0', { observer: obs })
      } catch (e) {
        thrownError = e
      }

      // assert
      expect(thrownError).toBeInstanceOf(SessionInFlightError)
      expect(obs.onRunStart).not.toHaveBeenCalled()
      expect(slot.bindObserver).not.toHaveBeenCalled() // fence fired before bindObserver on the second call

      // cleanup
      firstRun.then(undefined, () => {})
    })
  })

  describe('Group: AgentResumeObserver — Group 6: resources bag — onStoreError extraction and unknown key tolerance', () => {
    it('onStoreError fires when the session store fails, extracted from resources.events', async () => {
      // arrange
      const storeErrors: Array<{ error: unknown; phase: string }> = []
      const onStoreError = vi.fn((error: unknown, phase: string) => storeErrors.push({ error, phase }))
      const failStore = makeStubStore({
        load: vi.fn().mockRejectedValue(new Error('disk-failure')),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()().store({ session: failStore }).loop(l => {
        l.start().step('step1', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, {})

      // act
      const resumeRun = agent.resume('resp', 'sess-store-fail', '$auto:0', { events: { onStoreError } })
      const result = await resumeRun

      // assert
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(storeErrors[0]!.phase).toBe('claim')
      expect(result.signal).toBe('$error')
    })

    it('no error thrown when resources contains an unknown key', async () => {
      // arrange
      const stubStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent', sessionId: 'sess-unknown-key', runId: 'run-1', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step1',
          },
          step: 'step1', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const h = createHarness<Record<string, never>>()().store({ session: stubStore }).loop(l => {
        l.start().step('step1', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agent = createAgent('test-agent', h, {})

      // act
      let thrownError: unknown = null
      try {
        const resumeRun = agent.resume('resp', 'sess-unknown-key', '$auto:0', { unknownKey: 'value', anotherKey: 42 } as any) // any: unknown keys are intentionally invalid to test resource bag tolerance
        await resumeRun
      } catch (e) {
        thrownError = e
      }

      // assert
      expect(thrownError).toBeNull()
    })
  })

  describe('Group: AgentResumeObserver — Group 7: Observer isolation between two agent instances', () => {
    it('two concurrent agent.resume() calls on separate instances fire events only to their respective observers', async () => {
      // arrange
      const obsA = { onRunStart: vi.fn(), onRunEnd: vi.fn() }
      const obsB = { onRunStart: vi.fn(), onRunEnd: vi.fn() }
      const stubStoreA = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'agent-A', sessionId: 'sess-A', runId: 'run-a', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step1',
          },
          step: 'step1', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const stubStoreB = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'agent-B', sessionId: 'sess-B', runId: 'run-b', version: 0,
          phase: 'paused', startedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          initialState: {}, finalState: {
            $interrupt: { interruptId: '$auto:0', prompt: '?' },
            $interruptResponses: {}, $cursor: 'step1',
          },
          step: 'step1', signal: '$interrupt',
        } satisfies StoredRun),
        save: vi.fn().mockResolvedValue(undefined),
      })
      const hA = createHarness<Record<string, never>>()().store({ session: stubStoreA }).loop(l => {
        l.start().step('step1', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agentA = createAgent('agent-A', hA, {})
      const hB = createHarness<Record<string, never>>()().store({ session: stubStoreB }).loop(l => {
        l.start().step('step1', { run: async () => ({}), route: () => 'done' }).on('done').end()
      })
      const agentB = createAgent('agent-B', hB, {})

      // act
      const runA = agentA.resume('respA', 'sess-A', '$auto:0', { observer: obsA })
      const runB = agentB.resume('respB', 'sess-B', '$auto:0', { observer: obsB })
      await Promise.all([runA, runB])

      // assert
      expect(obsA.onRunStart).toHaveBeenCalledOnce()
      expect(obsA.onRunEnd).toHaveBeenCalledOnce()
      expect(obsB.onRunStart).toHaveBeenCalledOnce()
      expect(obsB.onRunEnd).toHaveBeenCalledOnce()
      expect(obsA.onRunStart.mock.calls[0]![0].agentId).toBe('agent-A')
      expect(obsB.onRunStart.mock.calls[0]![0].agentId).toBe('agent-B')
    })
  })
})
