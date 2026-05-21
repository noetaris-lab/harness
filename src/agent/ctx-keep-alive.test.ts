import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createKeepAliveFn, type LeaseRef } from './ctx-keep-alive.js'
import type { SessionStore, Lease } from './session-store.js'

function makeStubStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    expiresAt: 1700000000000,
    agentId: 'ag-1',
    sessionId: 's1',
    token: 'tok-default',
    ...overrides,
  }
}

describe('createKeepAliveFn', () => {

  describe('no-op when no active lease', () => {

    it('resolves immediately without calling extendClaim when leaseRef.current is null (one-shot)', async () => {
      // arrange
      const leaseRef: LeaseRef = { current: null }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(makeLease()) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      await keepAlive()

      // assert
      expect(store.extendClaim).not.toHaveBeenCalled()
    })

    it('returns no-op stop function synchronously without starting a timer when leaseRef.current is null (background)', async () => {
      // arrange
      const leaseRef: LeaseRef = { current: null }
      const store = makeStubStore({ extendClaim: vi.fn() })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)
      vi.useFakeTimers()

      // act
      const stop = keepAlive({ every: 5_000 })
      vi.advanceTimersByTime(20_000)

      // assert
      expect(typeof stop).toBe('function')
      expect(store.extendClaim).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

  })

  describe('one-shot renewal — happy path', () => {

    it('calls extendClaim once and updates leaseRef.current on success (one-shot)', async () => {
      // arrange
      const initialLease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-1' }
      const renewedLease: Lease = { expiresAt: 1700000030000, agentId: 'ag-1', sessionId: 's1', token: 'tok-1' }
      const leaseRef: LeaseRef = { current: initialLease }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(renewedLease) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      await keepAlive()

      // assert
      expect(store.extendClaim).toHaveBeenCalledOnce()
      expect(leaseRef.current).toBe(renewedLease)
    })

    it('passes originalTtlMs as ttlMs in extendClaim options (one-shot)', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-2' }
      const renewedLease: Lease = { ...lease, expiresAt: 1700000060000 }
      const leaseRef: LeaseRef = { current: lease }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(renewedLease) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 60_000)

      // act
      await keepAlive()

      // assert
      expect(store.extendClaim).toHaveBeenCalledWith(lease, { ttlMs: 60_000 })
    })

  })

  describe('background renewal — happy path', () => {

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('calls extendClaim on each interval tick and accumulates call count (background)', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-3' }
      const leaseRef: LeaseRef = { current: lease }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(lease) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      keepAlive({ every: 100 })
      await vi.advanceTimersByTimeAsync(300)

      // assert
      expect(store.extendClaim).toHaveBeenCalledTimes(3)
    })

    it('updates leaseRef.current after each successful background tick', async () => {
      // arrange
      const lease1: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-4' }
      const lease2: Lease = { expiresAt: 1700000030000, agentId: 'ag-1', sessionId: 's1', token: 'tok-4' }
      const leaseRef: LeaseRef = { current: lease1 }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(lease2) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      keepAlive({ every: 100 })
      await vi.advanceTimersByTimeAsync(100)

      // assert
      expect(leaseRef.current).toBe(lease2)
    })

  })

  describe('stop function — cancellation and idempotency', () => {

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('no further extendClaim calls are made after stop() is called', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-5' }
      const leaseRef: LeaseRef = { current: lease }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(lease) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      const stop = keepAlive({ every: 100 })
      await vi.advanceTimersByTimeAsync(100)
      stop()
      vi.advanceTimersByTime(300)

      // assert
      expect(store.extendClaim).toHaveBeenCalledTimes(1)
    })

    it('calling stop() multiple times does not throw', () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-6' }
      const leaseRef: LeaseRef = { current: lease }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(lease) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act / assert
      const stop = keepAlive({ every: 100 })
      expect(() => { stop(); stop(); stop() }).not.toThrow()
    })

  })

  describe('error handling — one-shot and background', () => {

    it('rejection from extendClaim propagates to the one-shot caller', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-7' }
      const leaseRef: LeaseRef = { current: lease }
      const storeError = new Error('store unavailable')
      const store = makeStubStore({ extendClaim: vi.fn().mockRejectedValue(storeError) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      const act = () => keepAlive()

      // assert
      await expect(act()).rejects.toThrow('store unavailable')
    })

    it('rejection from extendClaim is swallowed in background mode and timer continues', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-8' }
      const leaseRef: LeaseRef = { current: lease }
      const store = makeStubStore({ extendClaim: vi.fn().mockRejectedValue(new Error('network error')) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)
      vi.useFakeTimers()

      // act
      keepAlive({ every: 100 })
      await vi.advanceTimersByTimeAsync(200)

      // assert
      expect(store.extendClaim).toHaveBeenCalledTimes(2)
      expect(leaseRef.current).toBe(lease)

      vi.useRealTimers()
    })

  })

  describe('no-op when store lacks extendClaim support', () => {

    it('resolves immediately when store is undefined (one-shot)', async () => {
      // arrange
      const leaseRef: LeaseRef = { current: null }
      const keepAlive = createKeepAliveFn(leaseRef, undefined, 0)

      // act
      const promise = keepAlive()

      // assert
      await expect(promise).resolves.toBeUndefined()
    })

    it('resolves immediately when store.extendClaim is absent (one-shot)', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-9' }
      const leaseRef: LeaseRef = { current: lease }
      const store: SessionStore = {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        claim: vi.fn().mockResolvedValue(lease),
        // extendClaim intentionally absent
      }
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      const promise = keepAlive()

      // assert
      await expect(promise).resolves.toBeUndefined()
    })

    it('returns no-op stop function without starting a timer when store.extendClaim is absent (background)', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-10' }
      const leaseRef: LeaseRef = { current: lease }
      const store: SessionStore = {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
        claim: vi.fn().mockResolvedValue(lease),
        // extendClaim intentionally absent
      }
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)
      vi.useFakeTimers()

      // act
      const stop = keepAlive({ every: 5_000 })
      vi.advanceTimersByTime(20_000)

      // assert
      expect(typeof stop).toBe('function')

      vi.useRealTimers()
    })

  })

  describe('LeaseRef dereference on each tick', () => {

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('skips extendClaim call on tick when leaseRef.current has become null after timer start, timer does not auto-stop', async () => {
      // arrange
      const lease: Lease = { expiresAt: 1700000000000, agentId: 'ag-1', sessionId: 's1', token: 'tok-11' }
      const leaseRef: LeaseRef = { current: lease }
      const store = makeStubStore({ extendClaim: vi.fn().mockResolvedValue(lease) })
      const keepAlive = createKeepAliveFn(leaseRef, store, 30_000)

      // act
      const stop = keepAlive({ every: 100 })

      // first tick fires while lease is active
      await vi.advanceTimersByTimeAsync(100)

      // simulate lease released by ClaimLifecycle
      leaseRef.current = null

      // second and third ticks fire after lease is gone
      await vi.advanceTimersByTimeAsync(200)

      stop()

      // assert
      expect(store.extendClaim).toHaveBeenCalledTimes(1)
    })

  })

})
