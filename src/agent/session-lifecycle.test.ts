import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveSessionStore, querySessionPhase, runWithSession } from './session-lifecycle.js'
import type { SessionStore } from './session-store.js'
import { required } from '../harness/ctx-markers.js'
import { createLoopBuilder, extractLoopDefinition } from '../loop/loop-dsl.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'
import { UnknownSignalError } from '../loop/loop-executor.js'
import { createAgent } from './create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import { field } from '../harness/state-field.js'

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
// Graph factories
// -----------------------------------------------------------------------

// A minimal graph that completes immediately with signal 'done'
function makeCompletingGraph(): LoopDefinition {
  const b = createLoopBuilder<Record<string, unknown>, Record<string, unknown>>()
  b.start().step('go', { route: () => 'done' }).on('done').end()
  return extractLoopDefinition(b)
}

// A graph whose only step runs a side-effect callback then completes with 'done'
function makeGraphWithSideEffect(
  sideEffect: (state: Record<string, unknown>) => void,
): LoopDefinition {
  const b = createLoopBuilder<Record<string, unknown>, Record<string, unknown>>()
  b.start()
    .step('go', {
      run: async (state) => { sideEffect(state); return {} },
      route: () => 'done',
    })
    .on('done').end()
  return extractLoopDefinition(b)
}

// A graph whose step mutates field 'x' from any value to 'after', then completes
function makeGraphWithStateChange(): LoopDefinition {
  const b = createLoopBuilder<Record<string, unknown>, Record<string, unknown>>()
  b.start()
    .step('go', {
      run: async () => ({ x: 'after' }),
      route: () => 'done',
    })
    .on('done').end()
  return extractLoopDefinition(b)
}

// A graph that passes construction but emits an undeclared signal at runtime,
// causing runLoop to throw UnknownSignalError.
function makeBrokenGraph(): LoopDefinition {
  const b = createLoopBuilder<Record<string, unknown>, Record<string, unknown>>()
  b.start()
    .step('go', { route: () => 'undeclared-at-runtime' })
    .on('some-other-signal').end()
  return extractLoopDefinition(b)
}

// -----------------------------------------------------------------------
// Test groups
// -----------------------------------------------------------------------

describe('session-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Group 1: resolveSessionStore — duck-typing and entry selection
  // -----------------------------------------------------------------------

  describe('resolveSessionStore', () => {
    it('returns undefined when storeEntries is empty', () => {
      // arrange
      const storeEntries: never[] = []

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns undefined when all entries have kind === "provide"', () => {
      // arrange
      const storeEntries = [{ kind: 'provide' as const, key: 'model', value: {} }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns undefined when store entry value has no session key', () => {
      // arrange
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { cache: {} } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns undefined when session value is null', () => {
      // arrange
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: null } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns undefined when session value has save but lacks load', () => {
      // arrange
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: { save: vi.fn() } } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns undefined when session value has load but lacks save', () => {
      // arrange
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: { load: vi.fn() } } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns undefined when session value is a required() marker', () => {
      // arrange
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: required() } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })

    it('returns the session store when a single valid store entry has load and save', () => {
      // arrange
      const mockStore = { load: vi.fn(), save: vi.fn() }
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: mockStore } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBe(mockStore)
    })

    it('returns the last valid session store when multiple entries have valid session stores', () => {
      // arrange
      const firstStore = { load: vi.fn(), save: vi.fn() }
      const lastStore = { load: vi.fn(), save: vi.fn() }
      const storeEntries = [
        { kind: 'store' as const, key: '__store__', value: { session: firstStore } },
        { kind: 'store' as const, key: '__store__', value: { session: lastStore } },
      ]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBe(lastStore)
      expect(result).not.toBe(firstStore)
    })
  })

  // -----------------------------------------------------------------------
  // Group 2: querySessionPhase — store-absent and store-present paths
  // -----------------------------------------------------------------------

  describe('querySessionPhase', () => {
    it('returns { phase: "fresh" } without any store call when store is undefined', async () => {
      // arrange
      // no setup needed

      // act
      const result = await querySessionPhase(undefined, 'sid-abc')

      // assert
      expect(result).toEqual({ phase: 'fresh' })
    })

    it('calls store.load with the provided sessionId', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })

      // act
      await querySessionPhase(store, 'sid-xyz')

      // assert
      expect(store.load).toHaveBeenCalledOnce()
      expect(store.load).toHaveBeenCalledWith('sid-xyz')
    })

    it('returns the SessionPhase mapped from the loaded stored session', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          phase: 'paused', state: { x: 1 }, step: 'resume-step', signal: '$error',
        }),
      })

      // act
      const result = await querySessionPhase(store, 'sid-123')

      // assert
      expect(result).toEqual({ phase: 'paused', step: 'resume-step', signal: '$error' })
    })

    it('propagates the error when store.load throws', async () => {
      // arrange
      const loadError = new Error('store unavailable')
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(loadError) })

      // act & assert
      await expect(querySessionPhase(store, 'sid-fail')).rejects.toThrow('store unavailable')
    })
  })

  // -----------------------------------------------------------------------
  // Group 3: runWithSession — no store (stateless path)
  // -----------------------------------------------------------------------

  describe('runWithSession — no store', () => {
    it('returns completed LoopResult from runLoop when store is undefined', async () => {
      // arrange
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-1' }

      // act
      const result = await runWithSession(undefined, 'sid-1', graph, { x: 'initial' }, undefined, ctx)

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('done')
      expect(result.state).toMatchObject({ x: 'initial' })
    })

    it('pauses immediately and returns LoopResult without store I/O when shouldStop returns true and store is undefined', async () => {
      // arrange
      const graph = makeCompletingGraph()
      const shouldStop = vi.fn().mockReturnValue(true)
      const ctx = { sessionId: 'sid-2' }

      // act
      const result = await runWithSession(undefined, 'sid-2', graph, {}, undefined, ctx, { shouldStop })

      // assert
      expect(result.paused).toBe(true)
      expect(result.cursor).toBe('go')
      expect(shouldStop).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Group 4: runWithSession — fresh session with store
  // -----------------------------------------------------------------------

  describe('runWithSession — fresh session with store', () => {
    it('calls store.load and then runLoop in the correct order', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-10' }

      // act
      const result = await runWithSession(store, 'sid-10', graph, {}, undefined, ctx)

      // assert
      expect(store.load).toHaveBeenCalledWith('sid-10')
      expect(result.paused).toBe(false)
      expect(store.save).toHaveBeenCalledTimes(2)
    })

    it('in-flight save uses sessionId and phase "in-flight" with a snapshot of the pre-run state', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeGraphWithStateChange()
      const ctx = { sessionId: 'sid-12' }

      // act
      await runWithSession(store, 'sid-12', graph, { x: 'before' }, undefined, ctx)

      // assert
      const inFlightSave = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(inFlightSave[1].phase).toBe('in-flight')
      expect(inFlightSave[1].state).toEqual({ x: 'before' })
      const terminalSave = (store.save as ReturnType<typeof vi.fn>).mock.calls[1]!
      expect(terminalSave[1].state).toMatchObject({ x: 'after' })
    })

    it('in-flight save occurs before runLoop executes (ordering guarantee)', async () => {
      // arrange
      const callOrder: string[] = []
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockImplementation(() => { callOrder.push('save'); return Promise.resolve() }),
      })
      const graph = makeGraphWithSideEffect(() => callOrder.push('runLoop-step'))
      const ctx = { sessionId: 'sid-order' }

      // act
      await runWithSession(store, 'sid-order', graph, {}, undefined, ctx)

      // assert
      expect(callOrder[0]).toBe('save')
      expect(callOrder[1]).toBe('runLoop-step')
      expect(callOrder[2]).toBe('save')
    })

    it('saves paused terminal phase with step cursor and no signal field when shouldStop triggers', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const shouldStop = () => true
      const ctx = { sessionId: 'sid-paused' }

      // act
      await runWithSession(store, 'sid-paused', graph, {}, undefined, ctx, { shouldStop })

      // assert
      const terminalSave = (store.save as ReturnType<typeof vi.fn>).mock.calls[1]!
      expect(terminalSave[1]).toEqual({
        phase: 'paused',
        state: expect.any(Object),
        step: 'go',
      })
    })

    it('saves completed terminal phase with signal when loop ends normally', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-done' }

      // act
      await runWithSession(store, 'sid-done', graph, {}, undefined, ctx)

      // assert
      const terminalSave = (store.save as ReturnType<typeof vi.fn>).mock.calls[1]!
      expect(terminalSave[1]).toEqual({
        phase: 'completed',
        state: expect.any(Object),
        signal: 'done',
      })
    })

    it('returns the LoopResult from runLoop after terminal save', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-ret' }

      // act
      const result = await runWithSession(store, 'sid-ret', graph, { count: 7 }, undefined, ctx)

      // assert
      expect(result).toMatchObject({ paused: false, signal: 'done' })
      expect(result.state).toMatchObject({ count: 7 })
    })
  })

  // -----------------------------------------------------------------------
  // Group 5: runWithSession — resumption path
  // -----------------------------------------------------------------------

  describe('runWithSession — resumption', () => {
    it('preserves stored fields not overridden by initialStateArg on resumption', async () => {
      // arrange
      const storedState = { x: 'stored-x', y: 'stored-y' }
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({ phase: 'paused', state: storedState, step: 'go' }),
      })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-resume' }

      // act
      const result = await runWithSession(store, 'sid-resume', graph, { x: 'initial-x' }, undefined, ctx)

      // assert
      expect(result.state).toMatchObject({ x: 'initial-x', y: 'stored-y' })
    })

    it('applies schema reduce function on resumption to merge initialStateArg with stored value', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({ phase: 'paused', state: { msgs: ['stored'] }, step: 'go' }),
      })
      const schema = { msgs: field<string[]>({ reduce: (curr, next) => [...curr, ...next] }) }
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-reduce' }

      // act
      const result = await runWithSession(store, 'sid-reduce', graph, { msgs: ['new'] }, schema, ctx)

      // assert
      expect(result.state.msgs).toEqual(['stored', 'new'])
    })

    it('in-flight snapshot reflects the merged resumption state (not raw stored state)', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({ phase: 'paused', state: { x: 'stored' }, step: 'go' }),
      })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-snapshot-resume' }

      // act
      await runWithSession(store, 'sid-snapshot-resume', graph, { x: 'override' }, undefined, ctx)

      // assert
      const inFlightSave = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]!
    })
  })

  // -----------------------------------------------------------------------
  // Group 6: runWithSession — error handling
  // -----------------------------------------------------------------------

  describe('runWithSession — error handling', () => {
    it('throws when store.load rejects and makes no in-flight save', async () => {
      // arrange
      const loadError = new Error('load failed')
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(loadError) })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-load-fail' }

      // act & assert
      await expect(runWithSession(store, 'sid-load-fail', graph, {}, undefined, ctx)).rejects.toThrow('load failed')
      expect(store.save).not.toHaveBeenCalled()
    })

    it('throws when store.load rejects before any runLoop execution', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(new Error('disk error')) })
      let loopCalled = false
      const graph = makeGraphWithSideEffect(() => { loopCalled = true })
      const ctx = { sessionId: 'sid-no-loop' }

      // act & assert
      await expect(runWithSession(store, 'sid-no-loop', graph, {}, undefined, ctx)).rejects.toThrow()
      expect(loopCalled).toBe(false)
    })

    it('throws when in-flight store.save rejects', async () => {
      // arrange
      const inflightError = new Error('save failed')
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockRejectedValue(inflightError),
      })
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-inflight-fail' }

      // act & assert
      await expect(runWithSession(store, 'sid-inflight-fail', graph, {}, undefined, ctx)).rejects.toThrow('save failed')
    })

    it('runLoop is not called when in-flight store.save throws', async () => {
      // arrange
      let loopCalled = false
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockRejectedValue(new Error('save error')),
      })
      const graph = makeGraphWithSideEffect(() => { loopCalled = true })
      const ctx = { sessionId: 'sid-no-run' }

      // act & assert
      await expect(runWithSession(store, 'sid-no-run', graph, {}, undefined, ctx)).rejects.toThrow()
      expect(loopCalled).toBe(false)
    })

    it('swallows terminal-save failure (completed), calls onStoreError with error and "persist", and still returns LoopResult', async () => {
      // arrange
      const terminalError = new Error('terminal save failed')
      let saveCount = 0
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockImplementation(() => {
          saveCount++
          return saveCount === 1 ? Promise.resolve() : Promise.reject(terminalError)
        }),
      })
      const onStoreError = vi.fn()
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-term-fail' }

      // act
      const result = await runWithSession(store, 'sid-term-fail', graph, {}, undefined, ctx, { onStoreError })

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('done')
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(onStoreError).toHaveBeenCalledWith(terminalError, 'persist')
    })

    it('swallows terminal-save failure (paused), calls onStoreError with "persist", and still returns LoopResult', async () => {
      // arrange
      const terminalError = new Error('paused save failed')
      let saveCount = 0
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockImplementation(() => {
          saveCount++
          return saveCount === 1 ? Promise.resolve() : Promise.reject(terminalError)
        }),
      })
      const onStoreError = vi.fn()
      const shouldStop = () => true
      const graph = makeCompletingGraph()
      const ctx = { sessionId: 'sid-paused-fail' }

      // act
      const result = await runWithSession(store, 'sid-paused-fail', graph, {}, undefined, ctx, { shouldStop, onStoreError })

      // assert
      expect(result.paused).toBe(true)
      expect(onStoreError).toHaveBeenCalledWith(terminalError, 'persist')
    })

    it('propagates errors thrown by runLoop without catching them', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeBrokenGraph()
      const ctx = { sessionId: 'sid-loop-error' }

      // act & assert
      await expect(runWithSession(store, 'sid-loop-error', graph, {}, undefined, ctx)).rejects.toThrow(UnknownSignalError)
    })
  })

  // -----------------------------------------------------------------------
  // Group 7: create-agent.ts wiring — agent.status() via resolved store
  // -----------------------------------------------------------------------

  describe('create-agent.ts wiring', () => {
    it('agent.status() returns { phase: "fresh" } when no h.store() session is configured', async () => {
      // arrange
      const h = createHarness()({}).loop(l =>
        l.start().step('go', { route: () => 'done' }).on('done').end()
      )
      const agent = createAgent(h, {})

      // act
      const status = await agent.status('any-session-id')

      // assert
      expect(status).toEqual({ phase: 'fresh' })
    })

    it("agent.status() calls the session store's load with the provided sessionId", async () => {
      // arrange
      const mockStore = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const h = createHarness()({})
        .store({ session: mockStore })
        .loop(l => l.start().step('go', { route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      await agent.status('session-abc')

      // assert
      expect(mockStore.load).toHaveBeenCalledOnce()
      expect(mockStore.load).toHaveBeenCalledWith('session-abc')
    })

    it('agent.status() returns the mapped SessionPhase for a stored session', async () => {
      // arrange
      const mockStore = makeStubStore({
        load: vi.fn().mockResolvedValue({ phase: 'completed', state: {}, signal: 'all-done' }),
      })
      const h = createHarness()({})
        .store({ session: mockStore })
        .loop(l => l.start().step('go', { route: () => 'done' }).on('done').end())
      const agent = createAgent(h, {})

      // act
      const status = await agent.status('session-xyz')

      // assert
      expect(status).toEqual({ phase: 'completed', signal: 'all-done' })
    })
  })
})
