import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createAgent,
  getAgentInternals,
  MissingLoopError,
  MissingSlotError,
  RuntimeSlotInAgentError,
  UnknownSlotError,
  AgentInternalsError,
} from './create-agent.js'
import { createHarness, getInternals } from '../harness/harness-builder.js'
import { HarnessInternalsError } from '../harness/harness-builder.js'
import { required, runtime } from '../harness/ctx-markers.js'
import { field } from '../harness/state-field.js'
import type { LoopBuilder } from '../loop/loop-dsl.js'

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
    it('agent.run() throws synchronously with "not implemented"', () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act & assert
      expect(() => agent.run({}, {})).toThrow(Error)
      expect(() => agent.run({}, {})).toThrow(/not implemented/i)
    })

    it('agent.resume() throws synchronously with "not implemented"', () => {
      // arrange
      const h = createHarness<Record<string, never>>()({}).loop(buildValidLoop)
      const agent = createAgent(h, {})

      // act & assert
      expect(() => agent.resume(undefined, 'session-1', 'interrupt-1')).toThrow(Error)
      expect(() => agent.resume(undefined, 'session-1', 'interrupt-1')).toThrow(/not implemented/i)
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
})
