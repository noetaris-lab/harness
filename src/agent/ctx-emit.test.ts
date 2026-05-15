import { describe, it, expect, vi } from 'vitest'
import { createEmitFn, extractRunListeners } from './ctx-emit.js'

describe('createEmitFn', () => {

  describe('dispatch behavior', () => {

    it('calls matching listener with the supplied payload', () => {
      // arrange
      const fn = vi.fn()
      const emit = createEmitFn({ 'foo': fn })

      // act
      emit('foo', 42)

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith(42)
    })

    it('does not call listener and does not throw when name is not registered', () => {
      // arrange
      const fn = vi.fn()
      const emit = createEmitFn({ 'foo': fn })

      // act
      emit('bar', 99)

      // assert
      expect(fn).not.toHaveBeenCalled()
      expect(() => emit('bar', 99)).not.toThrow()
    })

    it('is a complete no-op when listeners map is empty', () => {
      // arrange
      const emit = createEmitFn({})

      // act + assert
      expect(() => emit('anything', 'somePayload')).not.toThrow()
    })

    it('calls listener with undefined when payload is omitted', () => {
      // arrange
      const fn = vi.fn()
      const emit = createEmitFn({ 'e': fn })

      // act
      emit('e')

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith(undefined)
    })

    it('calls listener with undefined when payload is explicitly undefined', () => {
      // arrange
      const fn = vi.fn()
      const emit = createEmitFn({ 'e': fn })

      // act
      emit('e', undefined)

      // assert
      expect(fn).toHaveBeenCalledOnce()
      expect(fn).toHaveBeenCalledWith(undefined)
    })

    it('propagates listener throw unhandled', () => {
      // arrange
      const fn = vi.fn().mockImplementation(() => { throw new Error('listener boom') })
      const emit = createEmitFn({ 'e': fn })

      // act + assert
      expect(() => emit('e', 'payload')).toThrow('listener boom')
    })

    it('dispatches independently to each of multiple listeners', () => {
      // arrange
      const fnA = vi.fn()
      const fnB = vi.fn()
      const emit = createEmitFn({ 'a': fnA, 'b': fnB })

      // act
      emit('a', 1)
      emit('b', 2)

      // assert
      expect(fnA).toHaveBeenCalledOnce()
      expect(fnA).toHaveBeenCalledWith(1)
      expect(fnB).toHaveBeenCalledOnce()
      expect(fnB).toHaveBeenCalledWith(2)
    })

  })

})

describe('extractRunListeners', () => {

  describe('resource extraction', () => {

    it('returns {} when the listeners key is absent', () => {
      // arrange
      const resources: Record<string, unknown> = { other: 'value' }

      // act
      const result = extractRunListeners(resources)

      // assert
      expect(result).toEqual({})
    })

    it('returns the plain object when listeners is a valid map', () => {
      // arrange
      const fn = vi.fn()
      const resources: Record<string, unknown> = { listeners: { 'foo': fn } }

      // act
      const result = extractRunListeners(resources)

      // assert
      expect(result).toHaveProperty('foo', fn)
    })

    it('returns {} when listeners is null', () => {
      // arrange
      const resources: Record<string, unknown> = { listeners: null }

      // act
      const result = extractRunListeners(resources)

      // assert
      expect(result).toEqual({})
    })

    it('returns {} when listeners is an array', () => {
      // arrange
      const fn = vi.fn()
      const resources: Record<string, unknown> = { listeners: [fn] }

      // act
      const result = extractRunListeners(resources)

      // assert
      expect(result).toEqual({})
    })

    it('returns {} when listeners is a non-object primitive', () => {
      // arrange
      const resources: Record<string, unknown> = { listeners: 42 }

      // act
      const result = extractRunListeners(resources)

      // assert
      expect(result).toEqual({})
    })

  })

})

describe('createEmitFn edge cases', () => {

  describe('mutation visibility and non-function values', () => {

    it('mutation added to listeners map after createEmitFn is visible to emit', () => {
      // arrange
      const fn2 = vi.fn()
      const map: Record<string, (payload: unknown) => void> = { 'a': vi.fn() }
      const emit = createEmitFn(map)
      map['b'] = fn2

      // act
      emit('b', 'payload')

      // assert
      expect(fn2).toHaveBeenCalledOnce()
      expect(fn2).toHaveBeenCalledWith('payload')
    })

    it('throws TypeError when listener value is a non-function primitive', () => {
      // arrange
      const emit = createEmitFn({ 'x': 42 as unknown as (payload: unknown) => void })

      // act + assert
      expect(() => emit('x', 'payload')).toThrow(TypeError)
    })

  })

})
