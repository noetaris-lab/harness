import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  storedSessionToPhase,
  initializeState,
} from './session-store.js'
import type { StoredRun, SessionStore, StoredRunMetadata, Lease } from './session-store.js'

// -----------------------------------------------------------------------
// Helper — builds a minimal valid StoredRun with required fields
// -----------------------------------------------------------------------

function makeStoredRun(overrides: Partial<StoredRun> & { phase: StoredRun['phase'] }): StoredRun {
  return {
    agentId: 'a1',
    runId: 'r1',
    sessionId: 's1',
    version: 0,
    startedAt: '2026-01-01T00:00:00Z',
    settledAt: '2026-01-01T00:01:00Z',
    initialState: {},
    finalState: {},
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Group 1: storedSessionToPhase — null input (fresh session)
// -----------------------------------------------------------------------

describe('session-store', () => {

  describe('storedSessionToPhase — null input', () => {

    it('returns { phase: "fresh" } when loaded is null', () => {
      // arrange — none

      // act
      const result = storedSessionToPhase(null)

      // assert
      expect(result).toEqual({ phase: 'fresh' })
    })

  })

  // -----------------------------------------------------------------------
  // Group 2: storedSessionToPhase — paused records
  // -----------------------------------------------------------------------

  describe('storedSessionToPhase — paused records', () => {

    it('returns phase, step, and signal when paused record has all fields', () => {
      // arrange
      const run = makeStoredRun({
        phase: 'paused',
        step: 'stepA',
        signal: '$interrupt',
      })

      // act
      const result = storedSessionToPhase(run)

      // assert
      expect(result).toEqual({ phase: 'paused', step: 'stepA', signal: '$interrupt' })
    })

    it('returns paused result without signal key when paused record has no signal', () => {
      // arrange
      const run = makeStoredRun({ phase: 'paused', step: 'stepA' })

      // act
      const result = storedSessionToPhase(run)

      // assert
      expect(result).toEqual({ phase: 'paused', step: 'stepA' })
      expect('signal' in result).toBe(false)
    })

    it('returns step: "" and does not throw when paused record has no step field', () => {
      // arrange — cast to bypass TypeScript strictness for malformed record
      const run = makeStoredRun({ phase: 'paused' }) as unknown as StoredRun
      // remove step from the object to simulate malformed record
      const malformed = { ...run } as Record<string, unknown>
      delete malformed['step']

      // act
      const result = storedSessionToPhase(malformed as unknown as StoredRun)

      // assert
      expect(result.phase).toBe('paused')
      expect((result as Record<string, unknown>)['step']).toBe('')
    })

  })

  // -----------------------------------------------------------------------
  // Group 3: storedSessionToPhase — completed records
  // -----------------------------------------------------------------------

  describe('storedSessionToPhase — completed records', () => {

    it('returns phase and signal when completed record has a signal', () => {
      // arrange
      const run = makeStoredRun({ phase: 'completed', signal: 'done' })

      // act
      const result = storedSessionToPhase(run)

      // assert
      expect(result).toEqual({ phase: 'completed', signal: 'done' })
    })

    it('returns { phase: "completed" } without signal key when completed record has no signal', () => {
      // arrange
      const run = makeStoredRun({ phase: 'completed' })

      // act
      const result = storedSessionToPhase(run)

      // assert
      expect(result).toEqual({ phase: 'completed' })
      expect('signal' in result).toBe(false)
    })

  })

  // -----------------------------------------------------------------------
  // Group 4: initializeState — fresh session (stored is null)
  // -----------------------------------------------------------------------

  describe('initializeState — fresh session', () => {

    it('returns copy of initialStateArg for fresh session with no schema', () => {
      // arrange
      const initialStateArg = { x: 1, y: 2 }
      const schema = undefined

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect(result).toEqual({ x: 1, y: 2 })
      expect(result).not.toBe(initialStateArg)
    })

    it('applies schema default for key absent from initialStateArg', () => {
      // arrange
      const initialStateArg = { x: 1 }
      const schema = { y: { default: () => 99 } }

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect(result).toEqual({ x: 1, y: 99 })
    })

    it('does not include schema key when it has no default and is absent from initialStateArg', () => {
      // arrange
      const initialStateArg = { x: 1 }
      const schema = { z: {} }

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect('z' in result).toBe(false)
      expect(result).toEqual({ x: 1 })
    })

    it('does not inject framework-reserved fields for fresh session with no schema', () => {
      // arrange
      const initialStateArg = {}
      const schema = undefined

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect('$error' in result).toBe(false)
      expect('$interrupt' in result).toBe(false)
    })

  })

  // -----------------------------------------------------------------------
  // Group 5: initializeState — resumption (stored is non-null)
  // -----------------------------------------------------------------------

  describe('initializeState — resumption', () => {

    it('overrides stored key with initialStateArg value on resumption', () => {
      // arrange
      const stored = makeStoredRun({ phase: 'paused', step: 's1', finalState: { a: 1, b: 2 } })
      const initialStateArg = { b: 99 }
      const schema = undefined

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result).toEqual({ a: 1, b: 99 })
    })

    it('reads finalState not initialState on resumption', () => {
      // arrange
      const stored = makeStoredRun({
        phase: 'paused',
        step: 's1',
        finalState: { x: 42 },
        initialState: { x: 0 },
      })
      const initialStateArg = {}
      const schema = undefined

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result).toEqual({ x: 42 })
    })

    it('calls schema reduce with stored and arg values and uses the result', () => {
      // arrange
      const stored = makeStoredRun({ phase: 'paused', step: 's1', finalState: { count: 5 } })
      const initialStateArg = { count: 3 }
      const schema = { count: { reduce: (current: number, next: number) => current + next } }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result).toEqual({ count: 8 })
    })

    it('preserves framework-reserved fields from stored.finalState on resumption', () => {
      // arrange
      const stored = makeStoredRun({
        phase: 'paused',
        step: 's1',
        finalState: { $error: { message: 'oops' }, x: 1 },
      })
      const initialStateArg = {}
      const schema = undefined

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result.$error).toEqual({ message: 'oops' })
      expect(result.x).toBe(1)
    })

    it('applies schema default for key absent from both stored.finalState and initialStateArg', () => {
      // arrange
      const stored = makeStoredRun({ phase: 'paused', step: 's1', finalState: { a: 1 } })
      const initialStateArg = {}
      const schema = { b: { default: () => 7 } }

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result).toEqual({ a: 1, b: 7 })
    })

  })

  // -----------------------------------------------------------------------
  // Group 6: initializeState — immutability and edge cases
  // -----------------------------------------------------------------------

  describe('initializeState — immutability and edge cases', () => {

    it('does not mutate stored.finalState or initialStateArg and returns distinct object', () => {
      // arrange
      const stored = makeStoredRun({ phase: 'paused', step: 's1', finalState: { x: 1 } })
      const initialStateArg = { y: 2 }

      // act
      const result = initializeState(stored, initialStateArg, undefined)

      // assert
      expect(stored.finalState).toEqual({ x: 1 })
      expect(initialStateArg).toEqual({ y: 2 })
      expect(result).not.toBe(stored.finalState)
      expect(result).not.toBe(initialStateArg)
    })

    it('returns empty object when fresh session has empty arg and no schema', () => {
      // arrange — none

      // act
      const result = initializeState(null, {}, undefined)

      // assert
      expect(result).toEqual({})
    })

    it('preserves all keys from stored.finalState when initialStateArg is empty', () => {
      // arrange
      const stored = makeStoredRun({ phase: 'paused', step: 's1', finalState: { a: 1, b: 2, c: 3 } })
      const initialStateArg = {}
      const schema = undefined

      // act
      const result = initializeState(stored, initialStateArg, schema)

      // assert
      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })

    it('includes key with value undefined when initialStateArg contains it', () => {
      // arrange
      const initialStateArg: Record<string, unknown> = { x: undefined }
      const schema = undefined

      // act
      const result = initializeState(null, initialStateArg, schema)

      // assert
      expect('x' in result).toBe(true)
      expect(result.x).toBeUndefined()
    })

    it('treats empty schema object identically to undefined schema', () => {
      // arrange — none

      // act
      const result = initializeState(null, {}, {})

      // assert
      expect(result).toEqual({})
    })

  })

  // -----------------------------------------------------------------------
  // Group 3: StoredRun metadata field
  // -----------------------------------------------------------------------

  describe('StoredRun — metadata field', () => {

    it('reads metadata.instanceId when StoredRun is constructed with metadata', () => {
      // arrange
      const run: StoredRun = {
        agentId: 'a', runId: 'r1', sessionId: 's1', version: 0,
        startedAt: '2026-01-01T00:00:00Z', settledAt: '2026-01-01T00:00:01Z',
        phase: 'completed',
        initialState: {}, finalState: {},
        metadata: { instanceId: 'pod-1' },
      }

      // act
      const result = run.metadata?.instanceId

      // assert
      expect(result).toBe('pod-1')
    })

    it('returns undefined for metadata when StoredRun is constructed without metadata', () => {
      // arrange
      const run: StoredRun = {
        agentId: 'a', runId: 'r2', sessionId: 's2', version: 0,
        startedAt: '2026-01-01T00:00:00Z', settledAt: '2026-01-01T00:00:01Z',
        phase: 'completed',
        initialState: {}, finalState: {},
      }

      // act
      const result = run.metadata

      // assert
      expect(result).toBeUndefined()
    })

    it('reads domain field on StoredRunMetadata by value', () => {
      // arrange
      const meta: StoredRunMetadata = { instanceId: 'pod-1', tenantId: 'acme' }

      // act
      const tenant = meta['tenantId']

      // assert
      expect(tenant).toBe('acme')
      expect(meta.instanceId).toBe('pod-1')
    })

  })

  // -----------------------------------------------------------------------
  // Group 5: Optional SessionStore method detection
  // -----------------------------------------------------------------------

  describe('SessionStore — optional method detection', () => {

    function makeMinimalStore(): SessionStore {
      return {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
      }
    }

    let store: SessionStore

    beforeEach(() => {
      store = makeMinimalStore()
    })

    it('returns false for typeof store.claim === "function" when store omits claim', () => {
      // arrange — store has no claim method

      // act
      const result = typeof store.claim === 'function'

      // assert
      expect(result).toBe(false)
    })

    it('returns false for typeof store.release === "function" when store omits release', () => {
      // arrange — store has no release method

      // act
      const result = typeof store.release === 'function'

      // assert
      expect(result).toBe(false)
    })

    it('returns false for typeof store.extendClaim === "function" when store omits extendClaim', () => {
      // arrange — store has no extendClaim method

      // act
      const result = typeof store.extendClaim === 'function'

      // assert
      expect(result).toBe(false)
    })

  })

  // -----------------------------------------------------------------------
  // Group 6: Lease reference replacement after extendClaim
  // -----------------------------------------------------------------------

  describe('Lease — reference replacement after extendClaim', () => {

    it('replaces held lease reference with updated expiresAt after extendClaim resolves', async () => {
      // arrange
      const initialLease: Lease = {
        expiresAt: 1700000000000,
        agentId: 'ag-1',
        sessionId: 'sess-1',
        token: 'tok-abc',
      }
      const renewedLease: Lease = {
        expiresAt: 1700000060000, // +60 s
        agentId: 'ag-1',
        sessionId: 'sess-1',
        token: 'tok-abc',
      }
      const store: SessionStore = {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        extendClaim: vi.fn().mockResolvedValue(renewedLease),
      }
      let heldLease: Lease = initialLease

      // act
      // store.extendClaim! is safe — the store was constructed with that method above
      heldLease = await store.extendClaim!(heldLease, { ttlMs: 60_000 })

      // assert
      expect(heldLease.expiresAt).toBe(1700000060000)
      expect(heldLease.expiresAt).toBeGreaterThan(initialLease.expiresAt)
      expect(store.extendClaim).toHaveBeenCalledWith(initialLease, { ttlMs: 60_000 })
    })

  })

})
