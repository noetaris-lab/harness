import { describe, it, expect, vi } from 'vitest'
import { createHarness, getInternals, HarnessInternalsError, LoopNotDefinedError } from './harness-builder.js'
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
      expect(internals.loopDef).toBeUndefined()
    })

    it('stateSchema is undefined and providers is empty when inner factory called with no argument', () => {
      const internals = getInternals(createHarness()())

      expect(internals.stateSchema).toBeUndefined()
      expect(internals.providers).toEqual([])
      expect(internals.loopDef).toBeUndefined()
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
    it('stores loop definition after invoking and validating the builder', () => {
      const h = createHarness()()
      const f = vi.fn()
      const h2 = h.loop((l) =>
        l
          .start()
          .step('a', { run: f, route: () => 'done' })
          .on('done')
          .end(),
      )

      expect(h2).not.toBe(h)
      const internals = getInternals(h2)
      expect(internals.loopDef).toBeDefined()
      expect(internals.loopDef?.entryStep).toBe('a')
    })

    it('replaces first loop definition when loop is called twice', () => {
      const h = createHarness()()
      const f = vi.fn()
      const h2 = h.loop((l) =>
        l
          .start()
          .step('first', { run: f, route: () => 'done' })
          .on('done')
          .end(),
      )
      const h3 = h2.loop((l) =>
        l
          .start()
          .step('second', { run: f, route: () => 'done' })
          .on('done')
          .end(),
      )

      expect(getInternals(h3).loopDef?.entryStep).toBe('second')
      expect(getInternals(h2).loopDef?.entryStep).toBe('first')
    })

    it('loopDef is undefined on a builder that has not had loop() called', () => {
      const internals = getInternals(createHarness()())

      expect(internals.loopDef).toBeUndefined()
    })
  })

  describe('getInternals()', () => {
    it('returns internals with all expected fields when called on a real harness', () => {
      const h = createHarness<{ model: string }>()()
      const internals = getInternals(h)

      expect(internals).toHaveProperty('stateSchema')
      expect(internals).toHaveProperty('providers')
      expect(internals).toHaveProperty('loopDef')
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

  describe('HarnessInternalsError', () => {
    it('has correct name, message, and instanceof chain when constructed', () => {
      const err = new HarnessInternalsError()

      expect(err.name).toBe('HarnessInternalsError')
      expect(err.message).toContain('HarnessBuilder')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(HarnessInternalsError)
    })
  })

  describe('definition() — loop topology correctness', () => {
    it('returns LoopDefinition with correct entryStep and step name for a single-step loop', () => {
      // arrange
      const runFn = vi.fn()
      const routeFn = vi.fn().mockReturnValue('done')
      const h = createHarness()().loop(l => { l.start().step('think', { run: runFn, route: routeFn }).on('done').end() })

      // act
      const def = h.definition()

      // assert
      expect(def.entryStep).toBe('think')
      expect(def.steps).toHaveLength(1)
      expect(def.steps[0]!.name).toBe('think')
    })

    it('returns steps in declaration order for a two-step loop', () => {
      // arrange
      const runA = vi.fn()
      const routeA = vi.fn().mockReturnValue('next')
      const routeB = vi.fn().mockReturnValue('done')
      const h = createHarness()().loop(l => {
        l.start().step('a', { run: runA, route: routeA }).on('next').to('b').step('b', { route: routeB }).on('done').end()
      })

      // act
      const def = h.definition()

      // assert
      expect(def.steps).toHaveLength(2)
      expect(def.steps[0]!.name).toBe('a')
      expect(def.steps[1]!.name).toBe('b')
      expect(def.entryStep).toBe('a')
    })
  })

  describe('definition() — reference identity and immutability', () => {
    it('returns the same object reference on repeated calls', () => {
      // arrange
      const runFn = vi.fn()
      const routeFn = vi.fn().mockReturnValue('done')
      const h = createHarness()().loop(l => { l.start().step('s', { run: runFn, route: routeFn }).on('done').end() })

      // act
      const first = h.definition()
      const second = h.definition()

      // assert
      expect(first).toBe(second)
    })

    it('returns a frozen LoopDefinition object', () => {
      // arrange
      const runFn = vi.fn()
      const h = createHarness()().loop(l => { l.start().step('s', { run: runFn, route: () => 'done' }).on('done').end() })
      const def = h.definition()

      // act / assert
      expect(Object.isFrozen(def)).toBe(true)
    })

    it('returns a LoopDefinition whose steps array is frozen', () => {
      // arrange
      const runFn = vi.fn()
      const h = createHarness()().loop(l => { l.start().step('s', { run: runFn, route: () => 'done' }).on('done').end() })
      const def = h.definition()

      // act / assert
      expect(Object.isFrozen(def.steps)).toBe(true)
    })

    it('returns a LoopDefinition where each StepDef is frozen', () => {
      // arrange
      const runFn = vi.fn()
      const h = createHarness()().loop(l => { l.start().step('s', { run: runFn, route: () => 'done' }).on('done').end() })
      const def = h.definition()

      // act / assert
      expect(Object.isFrozen(def.steps[0])).toBe(true)
    })
  })

  describe('definition() — chaining preservation', () => {
    it('is available and returns correct definition after chaining provide() after loop()', () => {
      // arrange
      const runFn = vi.fn()
      const routeFn = vi.fn().mockReturnValue('done')
      const h = createHarness<{ x: string }>()()
        .loop(l => { l.start().step('s', { run: runFn, route: routeFn }).on('done').end() })
        .provide('x', 'value')

      // act
      const def = h.definition()

      // assert
      expect(def.entryStep).toBe('s')
      expect(def.steps).toHaveLength(1)
    })
  })

  describe('definition() — LoopNotDefinedError thrown before loop()', () => {
    it('throws LoopNotDefinedError on a freshly created harness with no calls', () => {
      // arrange
      const h = createHarness()()

      // act / assert
      expect(() => h.definition()).toThrow(LoopNotDefinedError)
    })

    it('throws LoopNotDefinedError after provide() calls but without loop()', () => {
      // arrange
      const h = createHarness<{ model: string }>()().provide('model', 'claude-3-haiku')

      // act / assert
      expect(() => h.definition()).toThrow(LoopNotDefinedError)
    })
  })

  describe('LoopNotDefinedError', () => {
    it('has name LoopNotDefinedError and message containing h.loop()', () => {
      // arrange
      const error = new LoopNotDefinedError()

      // act / assert
      expect(error.name).toBe('LoopNotDefinedError')
      expect(error.message).toContain('h.loop()')
    })
  })
})
