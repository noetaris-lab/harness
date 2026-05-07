import { describe, it, expect, expectTypeOf } from 'vitest'
import { createHarness, getInternals, HarnessInternalsError, type Harness } from './harness-builder.js'
import { field } from './state-field.js'
import { required, runtime } from './ctx-markers.js'

describe('HarnessBuilder', () => {
  describe('createHarness — outer and inner construction', () => {
    it('returns a Harness builder when outer call followed by inner call with no argument', () => {
      const h = createHarness<{ model: string }>()()

      expect(typeof h).toBe('object')
      expect(typeof h.provide).toBe('function')
      expect(typeof h.store).toBe('function')
      expect(typeof h.loop).toBe('function')
      expect(() => getInternals(h)).not.toThrow()
    })

    it('returns a Harness builder when createHarness is called with no type parameter', () => {
      const h = createHarness()()

      expect(typeof h).toBe('object')
      expect(typeof h.provide).toBe('function')
    })
  })

  describe('createHarness — inner call schema handling', () => {
    it('stores schema by reference when a valid schema object is passed', () => {
      const schema = { count: field<number>({ default: () => 0 }) }
      const internals = getInternals(createHarness<{ model: string }>()(schema))

      expect(internals.stateSchema).toBe(schema)
      expect(internals.providers).toEqual([])
      expect(internals.loopBuilder).toBeUndefined()
    })

    it('stateSchema is undefined and providers is empty when inner factory called with no argument', () => {
      const internals = getInternals(createHarness()())

      expect(internals.stateSchema).toBeUndefined()
      expect(internals.providers).toEqual([])
      expect(internals.loopBuilder).toBeUndefined()
    })

    it('stateSchema is the exact empty object when inner factory called with {}', () => {
      const emptySchema = {}
      const internals = getInternals(createHarness()(emptySchema))

      expect(internals.stateSchema).toBe(emptySchema)
    })
  })

  describe('provide() — single-call behavior', () => {
    it('returns a new builder with one ProviderEntry when called with RuntimeMarker', () => {
      const h = createHarness<{ model: string }>()()
      const marker = runtime()
      const h2 = h.provide('model', marker)

      expect(h2).not.toBe(h)
      expect(getInternals(h2).providers).toHaveLength(1)
      expect(getInternals(h2).providers[0]!).toEqual({ kind: 'provide', key: 'model', value: marker })
    })

    it('does not mutate the original builder when provide() is called', () => {
      const h = createHarness<{ model: string }>()()

      h.provide('model', runtime())

      expect(getInternals(h).providers).toHaveLength(0)
    })

    it('stores RequiredMarker in ProviderEntry when called with required()', () => {
      const h = createHarness<{ prompts: string }>()()
      const marker = required()
      const h2 = h.provide('prompts', marker)

      expect(getInternals(h2).providers[0]!).toEqual({ kind: 'provide', key: 'prompts', value: marker })
    })

    it('stores concrete value in ProviderEntry when called with a plain object', () => {
      const h = createHarness<{ tools: { search: () => void } }>()()
      const toolsObj = { search: () => {} }
      const h2 = h.provide('tools', toolsObj)

      expect(getInternals(h2).providers[0]!).toEqual({ kind: 'provide', key: 'tools', value: toolsObj })
      expect(getInternals(h2).providers[0]!.value).toBe(toolsObj)
    })

    it('stores entire nested-marker object without flattening when called with nested markers', () => {
      const h = createHarness<{ tools: { search: () => void; calc: () => void } }>()()
      const marker = required()
      const nestedValue = { search: () => {}, calc: marker }
      const h2 = h.provide('tools', nestedValue as any)

      expect(getInternals(h2).providers).toHaveLength(1)
      expect(getInternals(h2).providers[0]!.value).toBe(nestedValue)
    })
  })

  describe('provide() — chaining and independence', () => {
    it('accumulates three ProviderEntries in registration order when chained', () => {
      const h = createHarness<{ model: string; prompts: string; tools: object }>()()
      const h4 = h.provide('model', runtime()).provide('prompts', required()).provide('tools', {})

      expect(getInternals(h).providers).toHaveLength(0)
      expect(getInternals(h4).providers).toHaveLength(3)
      expect(getInternals(h4).providers[0]!.key).toBe('model')
      expect(getInternals(h4).providers[1]!.key).toBe('prompts')
      expect(getInternals(h4).providers[2]!.key).toBe('tools')
    })

    it('appends two ProviderEntries and does not throw when the same key is provided twice', () => {
      const h = createHarness<{ model: string }>()()
      const h3 = h.provide('model', runtime()).provide('model', runtime())

      expect(() => h.provide('model', runtime()).provide('model', runtime())).not.toThrow()
      expect(getInternals(h3).providers).toHaveLength(2)
      expect(getInternals(h3).providers[0]!.key).toBe('model')
      expect(getInternals(h3).providers[1]!.key).toBe('model')
    })

    it('produces independent builders when two branches are created from the same root', () => {
      const h = createHarness<{ model: string }>()()
      const branch1 = h.provide('model', runtime())
      const branch2 = h.provide('model', required())

      expect(getInternals(branch1).providers).toHaveLength(1)
      expect(getInternals(branch2).providers).toHaveLength(1)
      expect(getInternals(branch1).providers[0]!.value).not.toBe(getInternals(branch2).providers[0]!.value)
    })
  })

  describe('store()', () => {
    it('appends a kind:\'store\' ProviderEntry with the full stores object', () => {
      const h = createHarness<object>()()
      const storeObj = { session: { save: () => {} }, knowledge: { query: () => {} } }
      const h2 = h.store(storeObj as any)

      expect(h2).not.toBe(h)
      expect(getInternals(h2).providers).toHaveLength(1)
      expect(getInternals(h2).providers[0]!.kind).toBe('store')
      expect(getInternals(h2).providers[0]!.value).toBe(storeObj)
    })

    it('appends a kind:\'store\' entry with empty value when store is called with {}', () => {
      const h = createHarness()()
      const h2 = h.store({})

      expect(getInternals(h2).providers).toHaveLength(1)
      expect(getInternals(h2).providers[0]!.kind).toBe('store')
      expect(getInternals(h2).providers[0]!.value).toEqual({})
    })

    it('stores marker values inside the stores object without applying type-level updates', () => {
      const h = createHarness()()
      const marker = required()
      const storeObj = { session: marker }
      const h2 = h.store(storeObj as any)

      expect(getInternals(h2).providers[0]!.kind).toBe('store')
      expect(getInternals(h2).providers[0]!.value).toBe(storeObj)
    })

    it('appends two kind:\'store\' entries and does not throw when store is called twice', () => {
      const h = createHarness()()
      const h3 = h.store({ session: {} as any }).store({ cache: {} as any })

      expect(() => h.store({}).store({})).not.toThrow()
      expect(getInternals(h3).providers).toHaveLength(2)
      expect(getInternals(h3).providers[0]!.kind).toBe('store')
      expect(getInternals(h3).providers[1]!.kind).toBe('store')
    })

    it('preserves registration order across mixed store() and provide() calls', () => {
      const h = createHarness<{ model: string }>()()
      const h4 = h.store({ session: {} as any }).provide('model', runtime()).store({ cache: {} as any })

      expect(getInternals(h4).providers).toHaveLength(3)
      expect(getInternals(h4).providers[0]!.kind).toBe('store')
      expect(getInternals(h4).providers[1]!.kind).toBe('provide')
      expect(getInternals(h4).providers[2]!.kind).toBe('store')
    })
  })

  describe('loop()', () => {
    it('stores loop builder by reference without invoking it', () => {
      const h = createHarness()()
      let invoked = false
      const fn = (_l: unknown) => {
        invoked = true
      }
      const h2 = h.loop(fn)

      expect(h2).not.toBe(h)
      expect(invoked).toBe(false)
      expect(getInternals(h2).loopBuilder).toBe(fn)
    })

    it('replaces first loop builder when loop is called twice', () => {
      const h = createHarness()()
      const fn1 = (_l: unknown) => {}
      const fn2 = (_l: unknown) => {}
      const h3 = h.loop(fn1).loop(fn2)

      expect(getInternals(h3).loopBuilder).toBe(fn2)
      expect(getInternals(h3).loopBuilder).not.toBe(fn1)
    })

    it('loopBuilder is undefined on a builder that has not had loop() called', () => {
      const internals = getInternals(createHarness()())

      expect(internals.loopBuilder).toBeUndefined()
    })
  })

  describe('getInternals()', () => {
    it('returns internals with all expected fields when called on a real harness', () => {
      const h = createHarness<{ model: string }>()()
      const internals = getInternals(h)

      expect(internals).toHaveProperty('stateSchema')
      expect(internals).toHaveProperty('providers')
      expect(internals).toHaveProperty('loopBuilder')
      expect(internals).toHaveProperty('_req')
      expect(internals).toHaveProperty('_run')
      expect(internals._req).toBeUndefined()
      expect(internals._run).toBeUndefined()
    })

    it('throws HarnessInternalsError when called on a plain object', () => {
      expect(() => getInternals({} as any)).toThrow(HarnessInternalsError)
      expect(() => getInternals({} as any)).toThrow('HarnessBuilder')
    })

    it('throws HarnessInternalsError when called with null', () => {
      expect(() => getInternals(null as any)).toThrow(HarnessInternalsError)
    })

    it('returns the exact internals object attached at construction', () => {
      const h = createHarness()()
      const first = getInternals(h)
      const second = getInternals(h)

      expect(first).toBe(second)
    })
  })

  describe('providers array immutability', () => {
    it('does not reflect external mutation of the returned providers array', () => {
      const h = createHarness<{ model: string }>()().provide('model', runtime())
      const internals = getInternals(h)

      try {
        ;(internals.providers as any[]).push({ kind: 'provide', key: 'x', value: null })
      } catch {
        // frozen array throws
      }

      expect(getInternals(h).providers).toHaveLength(1)
    })
  })

  describe('type-level assertions', () => {
    it('return type has Run = "model" when provide("model", runtime()) is called', () => {
      const h = createHarness<{ model: string; prompts: string }>()()
      const h2 = h.provide('model', runtime())

      expectTypeOf(h2).toExtend<Harness<{ model: string; prompts: string }, {}, never, 'model'>>()
    })

    it('return type has Req = "prompts" when provide("prompts", required()) is called', () => {
      const h = createHarness<{ model: string; prompts: string }>()()
      const h2 = h.provide('prompts', required())

      expectTypeOf(h2).toExtend<Harness<{ model: string; prompts: string }, {}, 'prompts', never>>()
    })

    it('State type is { count: number } when schema contains field<number>()', () => {
      const schema = { count: field<number>({ default: () => 0 }) }
      const h = createHarness<{ model: string }>()(schema)

      expectTypeOf(h).toExtend<Harness<{ model: string }, { count: number }>>()
    })

    it('State type is {} when no schema argument is given', () => {
      const h = createHarness<{ model: string }>()()

      expectTypeOf(h).toExtend<Harness<{ model: string }, {}>>()
    })

    it('chained provide accumulates both Req and Run correctly', () => {
      const h = createHarness<{ model: string; prompts: string }>()()
      const h3 = h.provide('model', runtime()).provide('prompts', required())

      expectTypeOf(h3).toExtend<Harness<{ model: string; prompts: string }, {}, 'prompts', 'model'>>()
    })

    it('both Req and Run contain "model" when provide("model", required()) followed by provide("model", runtime())', () => {
      const h = createHarness<{ model: string }>()()
      const h3 = h.provide('model', required()).provide('model', runtime())

      expectTypeOf(h3).toExtend<Harness<{ model: string }, {}, 'model', 'model'>>()
    })

    it('TypeScript reports an error when a concrete value does not satisfy DeepWithMarkers<Ctx[K]>', () => {
      type Ctx = { model: { call(): Promise<string> } }
      const h = createHarness<Ctx>()()

      // @ts-expect-error — number is not assignable to DeepWithMarkers<{ call(): Promise<string> }>
      h.provide('model', 42)
    })

    it('TypeScript reports an error when an unknown key is passed to provide()', () => {
      type Ctx = { model: string }
      const h = createHarness<Ctx>()()

      // @ts-expect-error — number literal is not assignable to keyof Ctx
      h.provide(42, required())
    })
  })

  describe('HarnessInternalsError', () => {
    it('has correct name, message, and instanceof chain when constructed', () => {
      const err = new HarnessInternalsError()

      expect(err.name).toBe('HarnessInternalsError')
      expect(err.message).toContain('HarnessBuilder')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(HarnessInternalsError)
    })
  })
})
