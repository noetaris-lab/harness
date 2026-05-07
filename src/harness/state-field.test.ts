import { describe, it, expect, expectTypeOf } from 'vitest'
import { field, type FieldDefinition, type StateFromSchema } from './state-field.js'

describe('field', () => {
  describe('runtime object shape', () => {
    it('returns plain object with both default and reduce when both options are supplied', () => {
      // arrange
      const defaultFn = () => [] as string[]
      const reduceFn = (a: string[], b: string[]) => [...a, ...b]

      // act
      const result = field<string[]>({ default: defaultFn, reduce: reduceFn })

      // assert
      expect(result.default).toBe(defaultFn)
      expect(result.reduce).toBe(reduceFn)
      expect(Object.keys(result)).toEqual(expect.arrayContaining(['default', 'reduce']))
      expect(Object.keys(result)).toHaveLength(2)
    })

    it('returns plain object with default only when reduce is omitted', () => {
      // arrange
      const defaultFn = () => 0

      // act
      const result = field<number>({ default: defaultFn })

      // assert
      expect(result.default).toBe(defaultFn)
      expect('reduce' in result).toBe(false)
      expect(Object.keys(result)).toHaveLength(1)
    })

    it('returns plain object with reduce only when default is omitted', () => {
      // arrange
      const reduceFn = (a: string[], b: string[]) => [...a, ...b]

      // act
      const result = field<string[]>({ reduce: reduceFn })

      // assert
      expect(result.reduce).toBe(reduceFn)
      expect('default' in result).toBe(false)
      expect(Object.keys(result)).toHaveLength(1)
    })

    it('returns empty plain object when called with empty options object', () => {
      // act
      const result = field<boolean>({})

      // assert
      expect(Object.keys(result)).toHaveLength(0)
      expect('default' in result).toBe(false)
      expect('reduce' in result).toBe(false)
    })

    it('returns empty plain object when called with no argument, identical to empty-options case', () => {
      // act
      const noArg = field<boolean>()
      const emptyOpts = field<boolean>({})

      // assert
      expect(Object.keys(noArg)).toHaveLength(0)
      expect(noArg).toEqual(emptyOpts)
    })
  })

  describe('type-level behavior (StateFromSchema and phantom inference)', () => {
    it('StateFromSchema resolves single-field schema to exact mapped type', () => {
      // arrange
      const schema = { count: field<number>({ default: () => 0 }) }
      type S = typeof schema

      // assert
      expectTypeOf<StateFromSchema<S>>().toEqualTypeOf<{ count: number }>()
    })

    it('StateFromSchema resolves multi-key schema preserving all field types', () => {
      // arrange
      const schema = { messages: field<string[]>(), active: field<boolean>() }
      type S = typeof schema

      // assert
      expectTypeOf<StateFromSchema<S>>().toEqualTypeOf<{
        messages: string[]
        active: boolean
      }>()
    })

    it('StateFromSchema preserves complex nested type without flattening', () => {
      // arrange
      const schema = { index: field<Record<string, number[]>>({ default: () => ({}) }) }
      type S = typeof schema

      // assert
      expectTypeOf<StateFromSchema<S>>().toEqualTypeOf<{ index: Record<string, number[]> }>()
    })

    it('StateFromSchema resolves field<string[]>({}) (no default, no reduce) to string[] not never', () => {
      // arrange
      const schema = { tags: field<string[]>({}) }
      type S = typeof schema

      // assert
      expectTypeOf<StateFromSchema<S>>().toEqualTypeOf<{ tags: string[] }>()
    })

    it('StateFromSchema resolves non-FieldDefinition schema key to never', () => {
      // arrange
      type BadSchema = { x: 42 }

      // assert
      expectTypeOf<StateFromSchema<BadSchema>>().toEqualTypeOf<{ x: never }>()
    })

    it('FieldDefinition<any> in generic bound accepts concrete FieldDefinition<string[]>; FieldDefinition<unknown> does not', () => {
      // arrange
      const concrete = field<string[]>()

      // assert
      expectTypeOf(concrete).toExtend<FieldDefinition<any>>()
      expectTypeOf(concrete).not.toExtend<FieldDefinition<unknown>>()
    })
  })

  describe('error and invalid-input cases', () => {
    it('accessing default when undefined was passed does not crash', () => {
      // arrange
      const opts = { default: undefined } as any // any: tests caller passing explicit undefined, which FieldOptions<T> forbids via exactOptionalPropertyTypes

      // assert
      expect(() => field<string[]>(opts)).not.toThrow()
      const result = field<string[]>(opts)
      expect(result.default).toBeUndefined()
    })

    it('field() with no explicit type parameter infers T as unknown', () => {
      // act
      const result = field()

      // assert
      expectTypeOf(result).toEqualTypeOf<FieldDefinition<unknown>>()
    })
  })

  describe('edge cases and invariants', () => {
    it('the same factory function reference stored in multiple field() calls is stored independently', () => {
      // arrange
      const sharedDefault = () => 0

      // act
      const f1 = field<number>({ default: sharedDefault })
      const f2 = field<number>({ default: sharedDefault })

      // assert
      expect(f1).not.toBe(f2)
      expect(f1.default).toBe(sharedDefault)
      expect(f2.default).toBe(sharedDefault)
    })

    it('a mutating reducer is stored as-is without modification or wrapping', () => {
      // arrange
      const mutateFn = (a: string[], b: string[]) => {
        a.push(...b)
        return a
      }

      // act
      const result = field<string[]>({ reduce: mutateFn })

      // assert
      expect(result.reduce).toBe(mutateFn)
    })

    it('phantom symbol property is absent from the runtime object', () => {
      // arrange
      const result = field<string>()

      // assert
      expect(Object.getOwnPropertySymbols(result)).toHaveLength(0)
      expect(Object.getOwnPropertyNames(result)).toHaveLength(0)
    })

    it('two field() calls with the same options object produce structurally equal but distinct objects', () => {
      // arrange
      const opts = { default: () => 0 }

      // act
      const a = field<number>(opts)
      const b = field<number>(opts)

      // assert
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })
  })
})
