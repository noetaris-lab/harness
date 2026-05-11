import { describe, it, expect, vi } from 'vitest'
import { expectTypeOf } from 'vitest'
import {
  storedSessionToPhase,
  initializeState,
} from './session-store.js'
import type { StoredSession, SessionStore, SessionPhase } from './session-store.js'

// -----------------------------------------------------------------------
// Group 1: Types and type shapes
// -----------------------------------------------------------------------

describe('session-store', () => {

  describe('StoredSession types', () => {

    it('phase type excludes "fresh" — only stored phases', () => {
      // arrange / act / assert
      expectTypeOf<StoredSession['phase']>().toEqualTypeOf<'in-flight' | 'paused' | 'completed'>()
    })

    it('state is Record<string, unknown>', () => {
      // arrange / act / assert
      expectTypeOf<StoredSession['state']>().toEqualTypeOf<Record<string, unknown>>()
    })

    it('signal and step are optional strings', () => {
      // arrange / act / assert
      expectTypeOf<StoredSession['signal']>().toEqualTypeOf<string | undefined>()
      expectTypeOf<StoredSession['step']>().toEqualTypeOf<string | undefined>()
    })

  })

  describe('SessionPhase types', () => {

    it('all four variants have correct discriminant shapes', () => {
      // arrange / act / assert
      expectTypeOf<Extract<SessionPhase, { phase: 'fresh' }>['phase']>().toEqualTypeOf<'fresh'>()
      expectTypeOf<Extract<SessionPhase, { phase: 'in-flight' }>['step']>().toEqualTypeOf<null>()
      expectTypeOf<Extract<SessionPhase, { phase: 'paused' }>['step']>().toEqualTypeOf<string>()
      expectTypeOf<Extract<SessionPhase, { phase: 'paused' }>['signal']>().toEqualTypeOf<string | undefined>()
      expectTypeOf<Extract<SessionPhase, { phase: 'completed' }>['signal']>().toEqualTypeOf<string | undefined>()
    })

  })

  describe('SessionStore types', () => {

    it('load and save have correctly-typed signatures', () => {
      // arrange / act / assert
      expectTypeOf<SessionStore['load']>().toEqualTypeOf<(sessionId: string) => Promise<StoredSession | null>>()
      expectTypeOf<SessionStore['save']>().toEqualTypeOf<(sessionId: string, session: StoredSession) => Promise<void>>()
    })

  })

  // -----------------------------------------------------------------------
  // Group 2: storedSessionToPhase
  // -----------------------------------------------------------------------

  describe('storedSessionToPhase', () => {

    it('returns { phase: "fresh" } when given null', () => {
      // arrange / act
      const result = storedSessionToPhase(null)

      // assert
      expect(result).toEqual({ phase: 'fresh' })
    })

    it('returns { phase: "in-flight", step: null } and ignores all other stored fields', () => {
      // arrange
      const stored: StoredSession = { phase: 'in-flight', state: { x: 1 }, signal: 'some-signal', step: 'step-name' }

      // act
      const result = storedSessionToPhase(stored)

      // assert
      expect(result).toEqual({ phase: 'in-flight', step: null })
    })

    it('returns paused phase with step and signal when both present', () => {
      // arrange
      const stored: StoredSession = { phase: 'paused', state: {}, step: 'confirm_delete', signal: '$interrupt' }

      // act
      const result = storedSessionToPhase(stored)

      // assert
      expect(result).toEqual({ phase: 'paused', step: 'confirm_delete', signal: '$interrupt' })
    })

    it('returns paused phase without signal key when signal absent', () => {
      // arrange
      const stored: StoredSession = { phase: 'paused', state: {}, step: 'fetch_data' }

      // act
      const result = storedSessionToPhase(stored)

      // assert
      expect(result).toEqual({ phase: 'paused', step: 'fetch_data' })
      expect('signal' in result).toBe(false)
    })

    it('returns step: "" when paused record has no step field (defensive fallback)', () => {
      // arrange
      const stored = { phase: 'paused' as const, state: {} }

      // act
      const result = storedSessionToPhase(stored)

      // assert
      expect(result).toEqual({ phase: 'paused', step: '' })
    })

    it('returns completed phase with signal when signal present', () => {
      // arrange
      const stored: StoredSession = { phase: 'completed', state: {}, signal: 'order_processed' }

      // act
      const result = storedSessionToPhase(stored)

      // assert
      expect(result).toEqual({ phase: 'completed', signal: 'order_processed' })
    })

    it('returns completed phase without signal key when signal absent', () => {
      // arrange
      const stored: StoredSession = { phase: 'completed', state: {} }

      // act
      const result = storedSessionToPhase(stored)

      // assert
      expect(result).toEqual({ phase: 'completed' })
      expect('signal' in result).toBe(false)
    })

  })

  // -----------------------------------------------------------------------
  // Group 3: initializeState — fresh sessions
  // -----------------------------------------------------------------------

  describe('initializeState — fresh session', () => {

    it('includes all keys from initialStateArg in result', () => {
      // arrange
      const initialStateArg = { userId: 'u-1', count: 5, active: true }
      const schema = undefined

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect(result).toMatchObject({ userId: 'u-1', count: 5, active: true })
    })

    it('calls schema default and includes result for key absent from initialStateArg', () => {
      // arrange
      const defaultFn = vi.fn().mockReturnValue(42)
      const schema = { counter: { default: defaultFn } }
      const initialStateArg = {}

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect(defaultFn).toHaveBeenCalledOnce()
      expect(result.counter).toBe(42)
    })

    it('omits key from result when absent from both initialStateArg and schema default', () => {
      // arrange
      const schema = { noDefault: {} }
      const initialStateArg = {}

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect('noDefault' in result).toBe(false)
    })

    it('returns initialStateArg content when schema is undefined', () => {
      // arrange
      const initialStateArg = { name: 'Alice', score: 10 }

      // act
      const result = initializeState(null, initialStateArg, undefined)

      // assert
      expect(result).toEqual({ name: 'Alice', score: 10 })
    })

    it('does not inject $error or $interrupt into fresh session result', () => {
      // arrange
      const initialStateArg = { messages: [] }
      const schema = { messages: { default: () => [] } }

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect('$error' in result).toBe(false)
      expect('$interrupt' in result).toBe(false)
    })

  })

  // -----------------------------------------------------------------------
  // Group 4: initializeState — resumptions
  // -----------------------------------------------------------------------

  describe('initializeState — resumption', () => {

    it('base of result contains all fields from stored.state', () => {
      // arrange
      const stored = { phase: 'paused' as const, state: { messages: ['hello'], step_count: 3 }, step: 's1' }
      const initialStateArg = {}
      const schema = undefined

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result).toMatchObject({ messages: ['hello'], step_count: 3 })
    })

    it('applies reduce(storedValue, argValue) when schema defines reduce for a key in initialStateArg', () => {
      // arrange
      const reduceFn = vi.fn((current: string[], next: string[]) => [...current, ...next])
      const schema = { messages: { reduce: reduceFn } }
      const stored = { phase: 'paused' as const, state: { messages: ['hello'] }, step: 's1' }
      const initialStateArg = { messages: ['world'] }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(reduceFn).toHaveBeenCalledOnce()
      expect(reduceFn).toHaveBeenCalledWith(['hello'], ['world'])
      expect(result.messages).toEqual(['hello', 'world'])
    })

    it('passes undefined as currentValue to reduce when key is absent from stored.state', () => {
      // arrange
      const reduceFn = vi.fn((current: number | undefined, next: number) => (current ?? 0) + next)
      const schema = { newField: { reduce: reduceFn } }
      const stored = { phase: 'paused' as const, state: { messages: [] }, step: 's1' }
      const initialStateArg = { newField: 5 }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(reduceFn).toHaveBeenCalledWith(undefined, 5)
      expect(result.newField).toBe(5)
    })

    it('replaces stored value directly when initialStateArg key has no reduce in schema', () => {
      // arrange
      const schema = { label: {} }
      const stored = { phase: 'paused' as const, state: { label: 'old' }, step: 's1' }
      const initialStateArg = { label: 'new' }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result.label).toBe('new')
    })

    it('applies schema default for key absent from both stored.state and initialStateArg', () => {
      // arrange
      const defaultFn = vi.fn().mockReturnValue('default-value')
      const schema = { newKey: { default: defaultFn } }
      const stored = { phase: 'paused' as const, state: { existingKey: 1 }, step: 's1' }
      const initialStateArg = {}

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(defaultFn).toHaveBeenCalledOnce()
      expect(result.newKey).toBe('default-value')
    })

    it('preserves $error and $interrupt from stored.state without modification', () => {
      // arrange
      const storedError = new Error('step failed')
      const stored = { phase: 'paused' as const, state: { $error: storedError, $interrupt: null, messages: [] }, step: 's1' }
      const initialStateArg = { messages: ['hi'] }
      const schema = undefined

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result.$error).toBe(storedError)
      expect(result.$interrupt).toBeNull()
    })

    it('merges stored.state with initialStateArg via direct override when schema is undefined', () => {
      // arrange
      const stored = { phase: 'completed' as const, state: { a: 1, b: 2 } }
      const initialStateArg = { b: 99, c: 3 }

      // act
      const result = initializeState(stored, initialStateArg, undefined)

      // assert
      expect(result.a).toBe(1)
      expect(result.b).toBe(99)
      expect(result.c).toBe(3)
    })

    it('retains stored-only keys absent from both initialStateArg and schema', () => {
      // arrange
      const stored = { phase: 'paused' as const, state: { toolResult: { id: 'tr-1' }, messages: [] }, step: 's1' }
      const initialStateArg = { messages: ['hi'] }
      const schema = { messages: {} }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result.toolResult).toEqual({ id: 'tr-1' })
    })

  })

  // -----------------------------------------------------------------------
  // Group 5: initializeState — edge cases
  // -----------------------------------------------------------------------

  describe('initializeState — edge cases', () => {

    it('empty initialStateArg on fresh session returns only schema defaults', () => {
      // arrange
      const schema = { count: { default: () => 0 }, name: { default: () => 'anon' } }
      const initialStateArg = {}

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect(result).toEqual({ count: 0, name: 'anon' })
    })

    it('empty initialStateArg on resumption returns stored state plus schema defaults for new keys', () => {
      // arrange
      const schema = { existing: {}, newField: { default: () => 'fresh' } }
      const stored = { phase: 'paused' as const, state: { existing: 'val' }, step: 's1' }
      const initialStateArg = {}

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result.existing).toBe('val')
      expect(result.newField).toBe('fresh')
    })

    it('explicit undefined in initialStateArg on resumption overrides stored value', () => {
      // arrange
      const schema = { label: { default: () => 'default' } }
      const stored = { phase: 'paused' as const, state: { label: 'stored-value' }, step: 's1' }
      const initialStateArg = { label: undefined }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect('label' in result).toBe(true)
      expect(result.label).toBeUndefined()
    })

    it('explicit undefined in initialStateArg on fresh session overrides schema default', () => {
      // arrange
      const defaultFn = vi.fn().mockReturnValue('should-not-be-called')
      const schema = { label: { default: defaultFn } }
      const initialStateArg = { label: undefined }

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect(defaultFn).not.toHaveBeenCalled()
      expect('label' in result).toBe(true)
      expect(result.label).toBeUndefined()
    })

    it('empty schema {} behaves identically to schema = undefined', () => {
      // arrange
      const initialStateArg = { x: 1, y: 2 }
      const stored = { phase: 'paused' as const, state: { x: 10 }, step: 's1' }

      // act
      const withEmpty = initializeState(stored, initialStateArg, {})
      const withUndefined = initializeState(stored, initialStateArg, undefined)

      // assert
      expect(withEmpty).toEqual(withUndefined)
    })

    it('result is a fresh object — neither stored.state nor initialStateArg is mutated', () => {
      // arrange
      const storedState = { count: 5, messages: ['a'] }
      const stored = { phase: 'paused' as const, state: storedState, step: 's1' }
      const initialStateArg = { count: 99 }

      // act
      const result = initializeState(stored, initialStateArg, undefined)

      // assert
      expect(result).not.toBe(storedState)
      expect(result).not.toBe(initialStateArg)
      expect(storedState.count).toBe(5)
      expect(initialStateArg.count).toBe(99)
    })

  })

})
