import { describe, it, expect, vi } from 'vitest'
import { expectTypeOf } from 'vitest'
import type {
  LoopBuilder,
  RunFn,
  RouteFn,
  StepOptions,
  FrameworkState,
} from './loop-dsl.js'
import {
  createLoopBuilder,
  extractLoopDefinition,
  InvalidLoopBuilderError,
} from './loop-dsl.js'

describe('LoopDSL', () => {
  describe('createLoopBuilder', () => {
    it('produces empty LoopDefinition when no DSL calls are made', () => {
      // arrange
      const builder = createLoopBuilder()

      // act
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)

      // assert
      expect(def.startCalled).toBe(false)
      expect(def.entryStep).toBeUndefined()
      expect(def.steps).toEqual([])
      expect(def.onError).toBeUndefined()
    })
  })

  describe('start', () => {
    it('sets startCalled to true when called once', () => {
      // arrange
      const builder = createLoopBuilder()

      // act
      builder.start()

      // assert
      expect(extractLoopDefinition(builder as LoopBuilder<unknown, unknown>).startCalled).toBe(true)
    })

    it('startCalled remains true when start() is called a second time', () => {
      // arrange
      const builder = createLoopBuilder()
      builder.start()

      // act
      builder.start()

      // assert
      expect(extractLoopDefinition(builder as LoopBuilder<unknown, unknown>).startCalled).toBe(true)
      expect(extractLoopDefinition(builder as LoopBuilder<unknown, unknown>).entryStep).toBeUndefined()
    })

    it('entryStep is the first step declared after start() when onError() precedes start()', () => {
      // arrange
      const f = vi.fn()
      const builder = createLoopBuilder<{ x: number }, object>()

      // act
      builder.onError('handle').start().step('think', { run: f as RunFn<{ x: number }, object> })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.startCalled).toBe(true)
      expect(def.entryStep).toBe('think')
    })
  })

  describe('step', () => {
    it('step with both run and route produces correct StepDef fields', () => {
      // arrange
      const f = vi.fn() as RunFn<{ x: number }, object>
      const r = vi.fn() as RouteFn<{ x: number }>
      const builder = createLoopBuilder<{ x: number }, object>()

      // act
      builder.start().step('think', { run: f, route: r })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps).toHaveLength(1)
      expect(def.steps[0]!.name).toBe('think')
      expect(def.steps[0]!.run).toBe(f)
      expect(def.steps[0]!.route).toBe(r)
      expect(def.steps[0]!.transitions).toEqual([])
      expect(def.steps[0]!.next).toBeUndefined()
      expect(def.entryStep).toBe('think')
    })

    it('two steps in declaration order with entryStep as the first', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const g = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start().step('a', { run: f }).step('b', { run: g })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps).toHaveLength(2)
      expect(def.steps[0]!.name).toBe('a')
      expect(def.steps[1]!.name).toBe('b')
      expect(def.entryStep).toBe('a')
    })

    it('step before start() is collected but does not become entryStep', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const g = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.step('before', { run: f }).start().step('after', { run: g })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps).toHaveLength(2)
      expect(def.steps[0]!.name).toBe('before')
      expect(def.steps[1]!.name).toBe('after')
      expect(def.entryStep).toBe('after')
    })

    it('no start() call yields startCalled false and entryStep undefined', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.step('think', { run: f })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.startCalled).toBe(false)
      expect(def.entryStep).toBeUndefined()
      expect(def.steps).toHaveLength(1)
    })
  })

  describe('on/to/end', () => {
    it('on("done").end() records a kind-end transition on the step', () => {
      // arrange
      const r = vi.fn() as RouteFn<object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start().step('think', { route: r }).on('done').end()

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps[0]!.transitions).toEqual([{ signal: 'done', target: { kind: 'end' } }])
    })

    it('on().to() and on().end() chained — two transitions in declaration order', () => {
      // arrange
      const r = vi.fn() as RouteFn<object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start().step('think', { route: r }).on('next').to('act').on('done').end()

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps[0]!.transitions).toHaveLength(2)
      expect(def.steps[0]!.transitions[0]).toEqual({ signal: 'next', target: { kind: 'step', name: 'act' } })
      expect(def.steps[0]!.transitions[1]).toEqual({ signal: 'done', target: { kind: 'end' } })
    })

    it('on() after the second step attaches only to the most-recent step', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const r = vi.fn() as RouteFn<object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start().step('a', { run: f }).step('b', { route: r }).on('x').to('a')

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps[0]!.transitions).toEqual([])
      expect(def.steps[1]!.transitions).toEqual([{ signal: 'x', target: { kind: 'step', name: 'a' } }])
    })

    it('on() before any step is a no-op — transition not recorded anywhere', () => {
      // arrange
      const builder = createLoopBuilder<object, object>()

      // act
      builder.on('orphan').to('foo')

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps).toEqual([])
    })
  })

  describe('next', () => {
    it('next() sets next on the current step; subsequent step has next undefined', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const g = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start().step('a', { run: f }).next('b').step('b', { run: g })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps[0]!.next).toBe('b')
      expect(def.steps[1]!.next).toBeUndefined()
    })

    it('calling next() twice on the same step uses the last value', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start().step('a', { run: f }).next('b').next('c')

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.steps[0]!.next).toBe('c')
    })
  })

  describe('onError', () => {
    it('onError() sets def.onError to the given step name', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()

      // act
      builder.onError('handler').start().step('handler', { run: f })

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.onError).toBe('handler')
    })

    it('calling onError() twice keeps only the last value', () => {
      // arrange
      const builder = createLoopBuilder<object, object>()

      // act
      builder.onError('first').onError('second')

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.onError).toBe('second')
    })

    it('no onError() call leaves def.onError undefined', () => {
      // arrange
      const builder = createLoopBuilder<object, object>()

      // act
      builder.start()

      // assert
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)
      expect(def.onError).toBeUndefined()
    })
  })

  describe('extractLoopDefinition', () => {
    it('returned LoopDefinition and all nested objects are frozen', () => {
      // arrange
      const r = vi.fn() as RouteFn<object>
      const builder = createLoopBuilder<object, object>()
      builder.start().step('think', { route: r }).on('done').end()

      // act
      const def = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)

      // assert
      expect(Object.isFrozen(def)).toBe(true)
      expect(Object.isFrozen(def.steps)).toBe(true)
      expect(Object.isFrozen(def.steps[0]!)).toBe(true)
      expect(Object.isFrozen(def.steps[0]!.transitions)).toBe(true)
      expect(Object.isFrozen(def.steps[0]!.transitions[0]!)).toBe(true)
      expect(Object.isFrozen(def.steps[0]!.transitions[0]!.target)).toBe(true)
    })

    it('first snapshot is unaffected after builder accumulates more steps', () => {
      // arrange
      const f = vi.fn() as RunFn<object, object>
      const g = vi.fn() as RunFn<object, object>
      const builder = createLoopBuilder<object, object>()
      builder.start().step('a', { run: f })
      const firstDef = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)

      // act
      builder.step('b', { run: g })
      const secondDef = extractLoopDefinition(builder as LoopBuilder<unknown, unknown>)

      // assert
      expect(firstDef.steps).toHaveLength(1)
      expect(firstDef.steps[0]!.name).toBe('a')
      expect(secondDef.steps).toHaveLength(2)
      expect(secondDef.steps[1]!.name).toBe('b')
    })
  })

  describe('extractLoopDefinition identity guard', () => {
    it('throws InvalidLoopBuilderError when passed a plain object', () => {
      // act & assert
      expect(() => extractLoopDefinition({} as LoopBuilder<unknown, unknown>)).toThrow(
        InvalidLoopBuilderError,
      )
    })

    it('throws InvalidLoopBuilderError when passed null', () => {
      // act & assert
      expect(() => extractLoopDefinition(null as unknown as LoopBuilder<unknown, unknown>)).toThrow(
        InvalidLoopBuilderError,
      )
    })
  })

  describe('InvalidLoopBuilderError', () => {
    it('has correct name and message when constructed', () => {
      // act
      const err = new InvalidLoopBuilderError()

      // assert
      expect(err).toBeInstanceOf(InvalidLoopBuilderError)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('InvalidLoopBuilderError')
      expect(err.message).toBe('argument is not a LoopBuilder instance — was it created by createLoopBuilder?')
    })
  })

  describe('type-level checks', () => {
    it('RunFn state parameter includes user fields and framework fields; ctx includes sessionId; return excludes framework fields', () => {
      // arrange
      type State = { messages: string[] }
      type LLM = { generate: () => string }
      type Ctx = { model: LLM }

      // act & assert
      const fn: RunFn<State, Ctx> = async (state, ctx) => ({ messages: state.messages })

      expectTypeOf(fn).parameter(0).toHaveProperty('messages').toEqualTypeOf<string[]>()
      expectTypeOf(fn).parameter(0).toHaveProperty('$error').toEqualTypeOf<Error | null>()
      expectTypeOf(fn).parameter(1).toHaveProperty('model').toEqualTypeOf<LLM>()
      expectTypeOf(fn).parameter(1).toHaveProperty('sessionId').toEqualTypeOf<string>()
      expectTypeOf(fn).returns.toEqualTypeOf<Promise<Partial<{ messages: string[] }>> | Partial<{ messages: string[] }>>()
    })

    it('RouteFn state parameter includes user field and framework fields; no ctx; return is string', () => {
      // arrange
      type State = { count: number }

      // act & assert
      const fn: RouteFn<State> = (state) => (state.count > 0 ? 'pos' : 'zero')

      expectTypeOf(fn).parameter(0).toHaveProperty('count').toEqualTypeOf<number>()
      expectTypeOf(fn).parameter(0).toHaveProperty('$error').toEqualTypeOf<Error | null>()
      expectTypeOf(fn).parameters.toEqualTypeOf<[State & FrameworkState]>() // exactly one param, no ctx
      expectTypeOf(fn).returns.toEqualTypeOf<string>()
    })

    it('StepOptions allows both run and route to be absent at the type level', () => {
      // arrange
      type State = { x: number }

      // act & assert
      const opts: StepOptions<State, object> = {}

      expectTypeOf(opts).toHaveProperty('run').toEqualTypeOf<RunFn<State, object> | undefined>()
      expectTypeOf(opts).toHaveProperty('route').toEqualTypeOf<RouteFn<State> | undefined>()
    })
  })
})
