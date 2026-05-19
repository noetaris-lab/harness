import { describe, it, expect } from 'vitest'
import {
  required,
  runtime,
  isRequiredMarker,
  isRuntimeMarker,
} from './ctx-markers.js'

describe('CtxMarkers', () => {
  describe('required() factory', () => {
    it('returns plain object with _tag === "__noetaris_required__" and no other enumerable own properties', () => {
      const result = required()

      expect(result._tag).toBe('__noetaris_required__')
      expect(Object.keys(result)).toEqual(['_tag'])
      expect(Object.getOwnPropertySymbols(result)).toHaveLength(0)
    })

    it('returns a distinct object on each call (referential independence)', () => {
      const a = required()
      const b = required()

      expect(a).not.toBe(b)
      expect(a).toEqual(b)
      expect(a._tag).toBe(b._tag)
    })
  })

  describe('runtime() factory', () => {
    it('returns plain object with _tag === "__noetaris_runtime__" and no other enumerable own properties', () => {
      const result = runtime()

      expect(result._tag).toBe('__noetaris_runtime__')
      expect(Object.keys(result)).toEqual(['_tag'])
      expect(Object.getOwnPropertySymbols(result)).toHaveLength(0)
    })

    it('returns a distinct object on each call (referential independence)', () => {
      const a = runtime()
      const b = runtime()

      expect(a).not.toBe(b)
      expect(a).toEqual(b)
      expect(a._tag).toBe(b._tag)
    })
  })

  describe('tag discrimination', () => {
    it('required()._tag and runtime()._tag are distinct and do not equal each other', () => {
      const req = required()
      const run = runtime()

      expect(req._tag).not.toBe(run._tag)
      expect(req._tag).toBe('__noetaris_required__')
      expect(run._tag).toBe('__noetaris_runtime__')
    })
  })

  describe('isRequiredMarker', () => {
    it('returns true for the output of required()', () => {
      const value = required()

      const result = isRequiredMarker(value)

      expect(result).toBe(true)
    })

    it('returns false for the output of runtime()', () => {
      const value = runtime()

      const result = isRequiredMarker(value)

      expect(result).toBe(false)
    })

    it('returns false for null', () => {
      const result = isRequiredMarker(null)

      expect(result).toBe(false)
    })

    it('returns false for undefined', () => {
      const result = isRequiredMarker(undefined)

      expect(result).toBe(false)
    })

    it('returns false for a primitive number', () => {
      const result = isRequiredMarker(42)

      expect(result).toBe(false)
    })

    it('returns true for a plain object with the correct _tag string (structural, no class identity required)', () => {
      const value = { _tag: '__noetaris_required__' }

      const result = isRequiredMarker(value)

      expect(result).toBe(true)
    })

    it('returns false for an object with a different _tag value', () => {
      const value = { _tag: 'other' }

      const result = isRequiredMarker(value)

      expect(result).toBe(false)
    })

    it('returns false for an object with no _tag property', () => {
      const value = {}

      const result = isRequiredMarker(value)

      expect(result).toBe(false)
    })
  })

  describe('isRuntimeMarker', () => {
    it('returns true for the output of runtime()', () => {
      const value = runtime()

      const result = isRuntimeMarker(value)

      expect(result).toBe(true)
    })

    it('returns false for the output of required()', () => {
      const value = required()

      const result = isRuntimeMarker(value)

      expect(result).toBe(false)
    })

    it('returns false for null', () => {
      const result = isRuntimeMarker(null)

      expect(result).toBe(false)
    })

    it('returns false for undefined', () => {
      const result = isRuntimeMarker(undefined)

      expect(result).toBe(false)
    })

    it('returns false for a primitive number', () => {
      const result = isRuntimeMarker(42)

      expect(result).toBe(false)
    })

    it('returns true for a plain object with the correct _tag string (structural)', () => {
      const value = { _tag: '__noetaris_runtime__' }

      const result = isRuntimeMarker(value)

      expect(result).toBe(true)
    })

    it('returns false for an object with a different _tag value', () => {
      const value = { _tag: 'other' }

      const result = isRuntimeMarker(value)

      expect(result).toBe(false)
    })

    it('returns false for an object with no _tag property', () => {
      const value = {}

      const result = isRuntimeMarker(value)

      expect(result).toBe(false)
    })
  })

  describe('edge cases — type guard boundary conditions', () => {
    it('isRequiredMarker returns false for a deeply nested object whose child has the correct _tag', () => {
      const value = { a: { _tag: '__noetaris_required__' } }

      const result = isRequiredMarker(value)

      expect(result).toBe(false)
    })

    it('isRequiredMarker returns false when _tag is a non-string value (number)', () => {
      const value = { _tag: 42 }

      const result = isRequiredMarker(value as unknown)

      expect(result).toBe(false)
    })

    it('isRuntimeMarker returns false when _tag is a non-string value (boolean)', () => {
      const value = { _tag: true }

      const result = isRuntimeMarker(value as unknown)

      expect(result).toBe(false)
    })
  })
})
