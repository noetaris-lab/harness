import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgent } from './create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import {
  SessionInFlightError,
  SessionPendingInterruptError,
  StoreLoadError,
} from './concurrency-errors.js'
import type { SessionStore } from './session-store.js'

// -----------------------------------------------------------------------
// Stub factory
// -----------------------------------------------------------------------

function makeStubStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Loop factories
// -----------------------------------------------------------------------

// A loop that completes immediately with signal 'done'
function makeCompletingLoop() {
  const h = createHarness()({})
  return h.loop(l => l.start().step('go', { route: () => 'done' }).on('done').end())
}

// A loop that completes immediately, with a store wired
function makeCompletingLoopWithStore(store: SessionStore) {
  const h = createHarness()({})
  return h.store({ session: store }).loop(l =>
    l.start().step('go', { route: () => 'done' }).on('done').end()
  )
}

// A loop with a blocking step — does not complete until blocker resolves
function makeBlockingLoopWithStore(store: SessionStore, blocker: Promise<void>) {
  const h = createHarness()({})
  return h.store({ session: store }).loop(l =>
    l.start()
      .step('go', { run: async () => { await blocker; return {} }, route: () => 'done' })
      .on('done').end()
  )
}

// A loop that emits $interrupt once then completes on resume
function makeInterruptingLoopWithStore(store: SessionStore) {
  const h = createHarness()({})
  return h.store({ session: store }).loop(l =>
    l.start()
      .step('ask', {
        run: async (_s, ctx) => {
          await (ctx as unknown as { interrupt: (p: string, id: string) => Promise<unknown> }).interrupt('Question?', 'iid-1')
          return {}
        },
        route: () => 'done',
      })
      .on('done').end()
  )
}

// A loop that always emits $interrupt on every run.
// Uses two consecutive interrupts so that after replaying iid-1, it pauses on iid-2.
function makeAlwaysInterruptingLoopWithStore(store: SessionStore) {
  const h = createHarness()({})
  return h.store({ session: store }).loop(l =>
    l.start()
      .step('ask', {
        run: async (_s, ctx) => {
          await (ctx as unknown as { interrupt: (p: string, id: string) => Promise<unknown> }).interrupt('First?', 'iid-1')
          await (ctx as unknown as { interrupt: (p: string, id: string) => Promise<unknown> }).interrupt('Second?', 'iid-2')
          return {}
        },
        route: () => 'done',
      })
      .on('done').end()
  )
}

// -----------------------------------------------------------------------
// Helpers for building a store that supports interrupt resume
// -----------------------------------------------------------------------

// Create a store whose save captures the paused session state, and whose load
// returns null on first call (fresh), then the most-recently-saved paused session.
function makeInterruptCapturingStore() {
  let saved: Record<string, unknown> | null = null
  const store: SessionStore = {
    load: vi.fn().mockImplementation(() => {
      return Promise.resolve(saved)
    }),
    save: vi.fn().mockImplementation((_agentId: string, _id: string, session: Record<string, unknown>) => {
      saved = session
      return Promise.resolve()
    }),
  }
  return store
}

// -----------------------------------------------------------------------
// Group 1: In-flight fence — agent.run()
// -----------------------------------------------------------------------

describe('ConcurrencyGuard', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Group 1: In-flight fence — agent.run()', () => {

    it('throws SessionInFlightError when same sessionId called twice in the same tick', () => {
      // arrange
      let unblock!: () => void
      const blocker = new Promise<void>(r => { unblock = r })
      const store = makeStubStore()
      const h = makeBlockingLoopWithStore(store, blocker)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      const act2 = () => agent.run({}, { sessionId: 's1' })

      // assert
      expect(run1).toBeDefined()
      expect(act2).toThrow(SessionInFlightError)
      expect(act2).toThrow(expect.objectContaining({ sessionId: 's1' }))

      // cleanup
      unblock()
      return run1
    })

    it('allows re-run after the first run has fully settled', async () => {
      // arrange
      const store = makeStubStore()
      const h = makeCompletingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      const run2 = agent.run({}, { sessionId: 's1' })
      const result2 = await run2

      // assert
      expect(run2).toBeDefined()
      expect(result2.signal).toBe('done')
    })

    it('does not block agent.run() for a different sessionId', async () => {
      // arrange
      let unblock!: () => void
      const blocker = new Promise<void>(r => { unblock = r })
      const store = makeStubStore()
      const h = makeBlockingLoopWithStore(store, blocker)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      const act2 = () => agent.run({}, { sessionId: 's2' })

      // assert
      expect(act2).not.toThrow()

      // cleanup
      unblock()
      await run1
      await act2()
    })

    it('allows re-run after a load-failure run that resolved with signal "$error"', async () => {
      // arrange
      let loadCallCount = 0
      const loadError = new Error('db timeout')
      const store = makeStubStore({
        load: vi.fn().mockImplementation(() => {
          loadCallCount++
          if (loadCallCount === 1) return Promise.reject(loadError)
          return Promise.resolve(null)
        }),
      })
      const onStoreError = vi.fn()
      const h = makeCompletingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1', events: { onStoreError } })
      const result1 = await run1

      const run2 = agent.run({}, { sessionId: 's1', events: { onStoreError } })
      const result2 = await run2

      // assert
      expect(result1.signal).toBe('$error')
      expect(run2).toBeDefined()
      expect(result2.signal).toBe('done')
    })

  })

  // -----------------------------------------------------------------------
  // Group 2: Interrupt-pending fence — agent.run()
  // -----------------------------------------------------------------------

  describe('Group 2: Interrupt-pending fence — agent.run()', () => {

    it('throws SessionPendingInterruptError when session settled with $interrupt', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      const act2 = () => agent.run({}, { sessionId: 's1' })

      // assert
      expect(act2).toThrow(SessionPendingInterruptError)
      expect(act2).toThrow(expect.objectContaining({ sessionId: 's1' }))
    })

    it('agent.resume() clears interrupt-pending; subsequent agent.run() succeeds', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      const resumeRun = agent.resume('answer', 's1', 'iid-1')
      await resumeRun

      // assert — agent.run() must not throw after a cleared interrupt-pending
      let thrownErr: unknown = null
      try { await agent.run({}, { sessionId: 's1' }) } catch (e) { thrownErr = e }
      expect(thrownErr).toBeNull()
    })

    it('run.resume() clears interrupt-pending; subsequent agent.run() succeeds', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      const run2 = run1.resume('answer', 'iid-1')
      await run2

      // assert — agent.run() must not throw after a cleared interrupt-pending
      let thrownErr: unknown = null
      try { await agent.run({}, { sessionId: 's1' }) } catch (e) { thrownErr = e }
      expect(thrownErr).toBeNull()
    })

    it('run.resume() settles with $interrupt — interrupt-pending is re-added', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeAlwaysInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      const run2 = run1.resume('answer', 'iid-1')
      await run2

      const act3 = () => agent.run({}, { sessionId: 's1' })

      // assert
      expect(act3).toThrow(SessionPendingInterruptError)
    })

    it('agent.resume() settles with $interrupt — interrupt-pending is re-added', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeAlwaysInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      const resumeRun = agent.resume('answer', 's1', 'iid-1')
      await resumeRun

      const act3 = () => agent.run({}, { sessionId: 's1' })

      // assert
      expect(act3).toThrow(SessionPendingInterruptError)
    })

    it('normal outcome does not populate interruptPendingSessions', async () => {
      // arrange
      const store = makeStubStore()
      const h = makeCompletingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      // assert — agent.run() must not throw after a normal (non-interrupt) outcome
      let thrownErr: unknown = null
      try { await agent.run({}, { sessionId: 's1' }) } catch (e) { thrownErr = e }
      expect(thrownErr).toBeNull()
    })

  })

  // -----------------------------------------------------------------------
  // Group 3: In-flight fence — agent.resume()
  // -----------------------------------------------------------------------

  describe('Group 3: In-flight fence — agent.resume()', () => {

    it('throws SessionInFlightError when agent.run() is already in-flight for the session', () => {
      // arrange
      let unblock!: () => void
      const blocker = new Promise<void>(r => { unblock = r })
      const store = makeStubStore()
      const h = makeBlockingLoopWithStore(store, blocker)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      const act2 = () => agent.resume('answer', 's1', 'iid-1')

      // assert
      expect(act2).toThrow(SessionInFlightError)
      expect(act2).toThrow(expect.objectContaining({ sessionId: 's1' }))

      // cleanup
      unblock()
      return run1
    })

    it('two concurrent agent.resume() calls — second throws SessionInFlightError', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      // act
      const resume1 = agent.resume('answer', 's1', 'iid-1')
      const act2 = () => agent.resume('answer', 's1', 'iid-1')

      // assert
      expect(act2).toThrow(SessionInFlightError)

      // cleanup
      await resume1.then(null, () => { /* ignore errors */ })
    })

  })

  // -----------------------------------------------------------------------
  // Group 4: In-flight fence — run.resume()
  // -----------------------------------------------------------------------

  describe('Group 4: In-flight fence — run.resume()', () => {

    it('throws SessionInFlightError when session was re-entered in-flight via agent.resume()', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      // act — agent.resume() clears interrupt-pending and puts s1 in-flight synchronously
      const resumeViaAgent = agent.resume('a1', 's1', 'iid-1')

      // run1.resume() on the stale handle — s1 is already in-flight
      const actResume = () => run1.resume('a2', 'iid-1')

      // assert
      expect(actResume).toThrow(SessionInFlightError)
      expect(actResume).toThrow(expect.objectContaining({ sessionId: 's1' }))

      // cleanup
      await resumeViaAgent.then(null, () => { /* ignore errors */ })
    })

  })

  // -----------------------------------------------------------------------
  // Group 5: StoreLoadError wrapping in runWithSession
  // -----------------------------------------------------------------------

  describe('Group 5: StoreLoadError wrapping in runWithSession', () => {

    it('store.load() throws Error — onStoreError fires with StoreLoadError, run resolves', async () => {
      // arrange
      const loadError = new Error('db timeout')
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(loadError) })
      const onStoreError = vi.fn()
      const h = makeCompletingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run = agent.run({}, { sessionId: 's1', events: { onStoreError } })
      const result = await run

      // assert
      expect(result.signal).toBe('$error')
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(onStoreError).toHaveBeenCalledWith(
        expect.objectContaining({ cause: loadError }),
        'load',
      )
      const [storeLoadErr] = onStoreError.mock.calls[0]!
      expect(storeLoadErr).toBeInstanceOf(StoreLoadError)
      expect(storeLoadErr.cause).toBe(loadError)
    })

    it('store.load() throws a non-Error value — StoreLoadError.cause preserves the raw value', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockRejectedValue('timeout') })
      const onStoreError = vi.fn()
      const h = makeCompletingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run = agent.run({}, { sessionId: 's1', events: { onStoreError } })
      const result = await run

      // assert
      expect(result.signal).toBe('$error')
      expect(onStoreError).toHaveBeenCalledOnce()
      const [storeLoadErr] = onStoreError.mock.calls[0]!
      expect(storeLoadErr).toBeInstanceOf(StoreLoadError)
      expect(storeLoadErr.cause).toBe('timeout')
    })

    it('no store configured — run completes normally, no StoreLoadError', async () => {
      // arrange
      const onStoreError = vi.fn()
      const h = makeCompletingLoop()
      const agent = createAgent('test-agent', h, {})

      // act
      const run = agent.run({}, { sessionId: 's1', events: { onStoreError } })
      const result = await run

      // assert
      expect(result.signal).toBe('done')
      expect(onStoreError).not.toHaveBeenCalled()
    })

  })

  // -----------------------------------------------------------------------
  // Group 6: Ordering and cleanup invariants
  // -----------------------------------------------------------------------

  describe('Group 6: Ordering and cleanup invariants', () => {

    it('SessionInFlightError does not modify inFlightSessions — third call succeeds after first settles', async () => {
      // arrange
      let unblock!: () => void
      const blocker = new Promise<void>(r => { unblock = r })
      const store = makeStubStore()
      const h = makeBlockingLoopWithStore(store, blocker)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })

      let caughtErr: unknown
      try { agent.run({}, { sessionId: 's1' }) } catch (e) { caughtErr = e }

      unblock()
      await run1

      const run3 = agent.run({}, { sessionId: 's1' })
      const result3 = await run3

      // assert
      expect(caughtErr).toBeInstanceOf(SessionInFlightError)
      expect(run3).toBeDefined()
      expect(result3.signal).toBe('done')
    })

    it('SessionPendingInterruptError does not add to inFlightSessions — agent.resume() succeeds after the error', async () => {
      // arrange
      const store = makeInterruptCapturingStore()
      const h = makeInterruptingLoopWithStore(store)
      const agent = createAgent('test-agent', h, {})

      // act
      const run1 = agent.run({}, { sessionId: 's1' })
      await run1

      let caughtErr: unknown
      try { agent.run({}, { sessionId: 's1' }) } catch (e) { caughtErr = e }

      const resumeRun = agent.resume('answer', 's1', 'iid-1')
      const resumeResult = await resumeRun

      // assert
      expect(caughtErr).toBeInstanceOf(SessionPendingInterruptError)
      expect(resumeRun).toBeDefined()
      expect(resumeResult.signal).toBe('done')
    })

  })

})
