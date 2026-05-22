import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SessionStore, StoredRun } from './session-store.js'
import { runWithSession, resolveSessionStore, querySessionPhase } from './session-lifecycle.js'
import { InterruptPause } from './ctx-interrupt.js'
import { UnknownSignalError } from '../loop/loop-executor.js'
import { createLoopBuilder, extractLoopDefinition } from '../loop/loop-dsl.js'
import type { LoopDefinition } from '../loop/loop-dsl.js'
import type { RunContext } from './observer.js'
import * as loopExecutorModule from '../loop/loop-executor.js'
import { createHarness } from '../harness/harness-builder.js'
import { createAgent } from './create-agent.js'

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

// A graph whose step changes field 'x' from any value to 'after', then completes with 'done'
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
    .on('declared').end()
  return extractLoopDefinition(b)
}

// A graph that triggers ctx.interrupt() on step 'stepB', causing runLoop to return
// paused with signal '$interrupt' and cursor 'stepB'.
function makeInterruptingGraph(): LoopDefinition {
  const b = createLoopBuilder<Record<string, unknown>, Record<string, unknown>>()
  b.start()
    .step('stepB', {
      run: async (_state, ctx) => { await (ctx as unknown as { interrupt: (p: unknown) => Promise<unknown> }).interrupt('what color?'); return {} },
      route: () => 'done',
    })
    .on('done').end()
  return extractLoopDefinition(b)
}

// Sets up a vi.spyOn on the runLoop export so that the next call returns
// { signal: null, paused: false, state: {}, cursor: null }.
// Used to exercise the defensive null-signal branch in runWithSession.
function spyRunLoopNoSignal(): void {
  vi.spyOn(loopExecutorModule, 'runLoop').mockResolvedValueOnce({
    signal: null,
    paused: false,
    state: {},
    cursor: null,
  })
}

// -----------------------------------------------------------------------
// Test groups
// -----------------------------------------------------------------------

describe('session-lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Group 1: runWithSession — no store (stateless path)
  // -----------------------------------------------------------------------

  describe('runWithSession — no store', () => {
    it('returns completed LoopResult using initialStateArg when store is undefined', async () => {
      // arrange
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-nostore' }

      // act
      const result = await runWithSession(undefined, 'test-agent', 'sid-nostore', randomUUID(), graph, { x: 'hello' }, undefined, ctx)

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('done')
      expect(result.state).toMatchObject({ x: 'hello' })
    })
  })

  // -----------------------------------------------------------------------
  // Group 2: runWithSession — load failure
  // -----------------------------------------------------------------------

  describe('runWithSession — load failure', () => {
    it('calls onStoreError with error and "load" and returns synthetic result with signal "$error"', async () => {
      // arrange
      const loadError = new Error('db timeout')
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(loadError) })
      const onStoreError = vi.fn()
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-load-fail' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-load-fail', randomUUID(), graph, {}, undefined, ctx, { onStoreError })

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('$error')
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(onStoreError).toHaveBeenCalledWith(expect.objectContaining({ cause: loadError }), 'load')
      expect(store.save).not.toHaveBeenCalled()
    })

    it('returns synthetic LoopResult with signal "$error" and does not throw when onStoreError is not provided', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(new Error('disk fail')) })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-load-fail-silent' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-load-fail-silent', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('$error')
    })
  })

  // -----------------------------------------------------------------------
  // Group 3: runWithSession — StoredRun fields on fresh session
  // -----------------------------------------------------------------------

  describe('runWithSession — StoredRun fields on fresh session', () => {
    it('saves StoredRun with phase "completed", initialState, and non-empty settledAt', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-fresh-fields' }

      // act
      await runWithSession(store, 'test-agent', 'sid-fresh-fields', randomUUID(), graph, { count: 3 }, undefined, ctx)

      // assert
      expect(store.save).toHaveBeenCalledOnce()
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.phase).toBe('completed')
      expect(saved.initialState).toEqual({ count: 3 })
      expect(saved.settledAt).toBeTruthy()
      expect(saved.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('saved StoredRun has the caller-supplied runId and non-empty ISO startedAt', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-runid' }
      const expectedRunId = randomUUID()

      // act
      await runWithSession(store, 'test-agent', 'sid-runid', expectedRunId, graph, {}, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.runId).toBe(expectedRunId)
      expect(saved.startedAt).toBeTruthy()
      expect(saved.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  // -----------------------------------------------------------------------
  // Group 4: runWithSession — resumption path
  // -----------------------------------------------------------------------

  describe('runWithSession — resumption', () => {
    it('saved initialState equals loaded finalState, not initialStateArg, on resumption', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-resume',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'paused',
          initialState: { x: 0 },
          finalState: { x: 5 },
          step: 'go', // 'go' matches the entry step of makeCompletingGraph()
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-resume' }

      // act
      await runWithSession(store, 'test-agent', 'sid-resume', randomUUID(), graph, {}, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.initialState).toEqual({ x: 5 })
    })

    it('saved runId equals the caller-supplied runId, not the loaded record runId', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'known-old-run-id',
          sessionId: 'sid-resume-id',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'paused',
          initialState: {},
          finalState: { x: 5 },
          step: 'go', // 'go' matches the entry step of makeCompletingGraph()
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-resume-id' }
      const freshRunId = randomUUID()

      // act
      await runWithSession(store, 'test-agent', 'sid-resume-id', freshRunId, graph, {}, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.runId).toBe(freshRunId)
      expect(saved.runId).not.toBe('known-old-run-id')
    })
  })

  // -----------------------------------------------------------------------
  // Group 5: runWithSession — initialState snapshot isolation
  // -----------------------------------------------------------------------

  describe('runWithSession — initialState snapshot isolation', () => {
    it('initialState is the pre-loop snapshot; finalState is the post-loop state', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeGraphWithStateChange()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-snapshot' }

      // act
      await runWithSession(store, 'test-agent', 'sid-snapshot', randomUUID(), graph, { x: 'before' }, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.initialState).toEqual({ x: 'before' })
      expect(saved.finalState).toMatchObject({ x: 'after' })
    })
  })

  // -----------------------------------------------------------------------
  // Group 6: runWithSession — paused terminal save shape
  // -----------------------------------------------------------------------

  describe('runWithSession — paused terminal save shape', () => {
    it('saved record has phase "paused", step from loop cursor, and signal when loop pauses with a signal', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeInterruptingGraph()
      const ctx = {
        agentId: 'test-agent',
        sessionId: 'sid-paused-sig',
        interrupt: (prompt: unknown, id?: string) => { throw new InterruptPause(id ?? 'auto-id', prompt) },
      }

      // act
      await runWithSession(store, 'test-agent', 'sid-paused-sig', randomUUID(), graph, {}, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.phase).toBe('paused')
      expect(saved.step).toBe('stepB')
      expect(saved.signal).toBe('$interrupt')
      expect('finalState' in saved).toBe(true)
    })

    it('saved record has phase "paused" and no signal field when loop pauses via shouldStop', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const shouldStop = () => true
      const ctx = { agentId: 'test-agent', sessionId: 'sid-paused-nosig' }

      // act
      await runWithSession(store, 'test-agent', 'sid-paused-nosig', randomUUID(), graph, {}, undefined, ctx, { shouldStop })

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.phase).toBe('paused')
      expect(saved.step).toBe('go')
      expect('signal' in saved).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Group 7: runWithSession — completed terminal save shape
  // -----------------------------------------------------------------------

  describe('runWithSession — completed terminal save shape', () => {
    it('saved record has phase "completed", signal, and no step when loop exits with a signal', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-completed-sig' }

      // act
      await runWithSession(store, 'test-agent', 'sid-completed-sig', randomUUID(), graph, {}, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.phase).toBe('completed')
      expect(saved.signal).toBe('done')
      expect('step' in saved).toBe(false)
    })

    it('saved record has phase "completed" and no signal field when loop exits with null signal', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-completed-nosig' }
      spyRunLoopNoSignal()

      // act
      await runWithSession(store, 'test-agent', 'sid-completed-nosig', randomUUID(), graph, {}, undefined, ctx)

      // assert
      const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
      expect(saved.phase).toBe('completed')
      expect('signal' in saved).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Group 8: runWithSession — terminal save error handling
  // -----------------------------------------------------------------------

  describe('runWithSession — terminal save error handling', () => {
    it('swallows terminal-save error, calls onStoreError with error and "persist", returns LoopResult', async () => {
      // arrange
      const terminalError = new Error('disk full')
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockRejectedValue(terminalError),
      })
      const onStoreError = vi.fn()
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-persist-fail' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-persist-fail', randomUUID(), graph, {}, undefined, ctx, { onStoreError })

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('done')
      expect(onStoreError).toHaveBeenCalledOnce()
      expect(onStoreError).toHaveBeenCalledWith(terminalError, 'persist')
    })

    it('swallows terminal-save error and returns LoopResult even when onStoreError is not provided', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockRejectedValue(new Error('write error')),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-persist-fail-silent' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-persist-fail-silent', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.paused).toBe(false)
      expect(result.signal).toBe('done')
    })
  })

  // -----------------------------------------------------------------------
  // Group 9: runWithSession — runLoop error propagation
  // -----------------------------------------------------------------------

  describe('runWithSession — runLoop error propagation', () => {
    it('propagates error from runLoop and makes no terminal save call', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeBrokenGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-loop-throw' }

      // act & assert
      await expect(runWithSession(store, 'test-agent', 'sid-loop-throw', randomUUID(), graph, {}, undefined, ctx)).rejects.toThrow(UnknownSignalError)
      expect(store.save).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Group 10: resolveSessionStore — duck-typing
  // -----------------------------------------------------------------------

  describe('resolveSessionStore', () => {
    it('returns the matching store object when an entry value has session with both load and save functions', () => {
      // arrange
      const mockStore = { load: vi.fn(), save: vi.fn() }
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: mockStore } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBe(mockStore)
    })

    it('returns undefined when no entry value has session with both load and save functions', () => {
      // arrange
      const storeEntries = [{ kind: 'store' as const, key: '__store__', value: { session: { load: vi.fn() } } }]

      // act
      const result = resolveSessionStore(storeEntries)

      // assert
      expect(result).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Group 13: querySessionPhase — phase resolution
  // -----------------------------------------------------------------------

  describe('querySessionPhase', () => {
    it('returns { phase: "fresh" } without any store call when store is undefined', async () => {
      // arrange — none

      // act
      const result = await querySessionPhase(undefined, 'test-agent', 'sid-nostore-status')

      // assert
      expect(result).toEqual({ phase: 'fresh' })
    })

    it('returns { phase: "fresh" } when store is present and store.load returns null', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })

      // act
      const result = await querySessionPhase(store, 'test-agent', 'sid-null-load')

      // assert
      expect(result).toEqual({ phase: 'fresh' })
      expect(store.load).toHaveBeenCalledWith('test-agent', 'sid-null-load')
    })

    it('returns { phase: "paused", step } when store returns a paused StoredRun', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'r1',
          sessionId: 'sid-paused-q',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'paused',
          initialState: {},
          finalState: {},
          step: 'stepX',
        }),
      })

      // act
      const result = await querySessionPhase(store, 'test-agent', 'sid-paused-q')

      // assert
      expect(result).toEqual({ phase: 'paused', step: 'stepX' })
    })
  })

  // -----------------------------------------------------------------------
  // Group 11: runWithSession — completed session short-circuit
  // -----------------------------------------------------------------------

  describe('runWithSession — completed session short-circuit', () => {
    it('returns stored finalState with cursor null and paused false when session is completed', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-completed-shape',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: { x: 42, label: 'settled' },
          signal: 'done',
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-completed-shape' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-completed-shape', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.state).toEqual({ x: 42, label: 'settled' })
      expect(result.cursor).toBeNull()
      expect(result.paused).toBe(false)
    })

    it('returns signal from stored run when signal is "done"', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-completed-signal-done',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: {},
          signal: 'done',
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-completed-signal-done' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-completed-signal-done', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.signal).toBe('done')
    })

    it('returns signal null when stored run has no signal field', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-completed-no-signal',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: {},
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-completed-no-signal' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-completed-no-signal', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.signal).toBeNull()
    })

    it('returns stored finalState unchanged when initialState arg contains additional fields', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-initial-ignored',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: { result: 'ok' },
          signal: 'done',
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-initial-ignored' }
      const initialStateArg = { extra: 'should-be-ignored', result: 'SHOULD-NOT-OVERWRITE' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-initial-ignored', randomUUID(), graph, initialStateArg, undefined, ctx)

      // assert
      expect(result.state).toEqual({ result: 'ok' })
      expect(result.state).not.toHaveProperty('extra')
    })

    it('does not call runLoop when session is completed', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-no-runloop',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: {},
          signal: 'done',
        }),
      })
      vi.spyOn(loopExecutorModule, 'runLoop')
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-no-runloop' }

      // act
      await runWithSession(store, 'test-agent', 'sid-no-runloop', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(loopExecutorModule.runLoop).not.toHaveBeenCalled()
    })

    it('does not call store.save when session is completed', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-no-save',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: {},
          signal: 'done',
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-no-save' }

      // act
      await runWithSession(store, 'test-agent', 'sid-no-save', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(store.save).not.toHaveBeenCalled()
    })

    it('does not call observer.onRunStart or observer.onRunEnd when session is completed', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-no-observer',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: {},
          signal: 'done',
        }),
      })
      const observer = { onRunStart: vi.fn(), onRunEnd: vi.fn() }
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-no-observer' }

      // act
      await runWithSession(store, 'test-agent', 'sid-no-observer', randomUUID(), graph, {}, undefined, ctx, { observer })

      // assert
      expect(observer.onRunStart).not.toHaveBeenCalled()
      expect(observer.onRunEnd).not.toHaveBeenCalled()
    })

    it('runs the full execution path when store.load returns null (fresh session)', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockResolvedValue(null) })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-fresh-path' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-fresh-path', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.signal).toBe('done')
      expect(store.save).toHaveBeenCalledOnce()
    })

    it('runs the full execution path when session is paused', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-paused-path',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'paused',
          initialState: {},
          finalState: {},
          step: 'go',
        }),
      })
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-paused-path' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-paused-path', randomUUID(), graph, {}, undefined, ctx)

      // assert
      expect(result.signal).toBe('done')
      expect(store.save).toHaveBeenCalledOnce()
    })

    it('runs the no-store path normally when store is undefined', async () => {
      // arrange
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-nostore-path' }

      // act
      const result = await runWithSession(undefined, 'test-agent', 'sid-nostore-path', randomUUID(), graph, { n: 1 }, undefined, ctx)

      // assert
      expect(result.signal).toBe('done')
      expect(result.state).toMatchObject({ n: 1 })
    })

    it('fires StoreLoadError path when store.load throws', async () => {
      // arrange
      const store = makeStubStore({ load: vi.fn().mockRejectedValue(new Error('db error')) })
      const onStoreError = vi.fn()
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-load-error-path' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-load-error-path', randomUUID(), graph, {}, undefined, ctx, { onStoreError })

      // assert
      expect(result.signal).toBe('$error')
      expect(onStoreError).toHaveBeenCalledWith(expect.objectContaining({ cause: expect.any(Error) }), 'load')
    })

    it('returns normally without throwing LeaseExpiredError when claim is active and session is completed', async () => {
      // arrange
      const store = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'old-run-id',
          sessionId: 'sid-lease-completed',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: { val: 7 },
          signal: 'ok',
        }),
      })
      const leaseRef = {
        current: {
          agentId: 'test-agent',
          sessionId: 'sid-lease-completed',
          expiresAt: Date.now() - 1000,
          token: 'lease-token-1',
        },
      }
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-lease-completed' }

      // act
      const result = await runWithSession(store, 'test-agent', 'sid-lease-completed', randomUUID(), graph, {}, undefined, ctx, { leaseRef })

      // assert
      expect(result.signal).toBe('ok')
      expect(result.state).toEqual({ val: 7 })
    })
  })

  // -----------------------------------------------------------------------
  // Group 14: create-agent.ts wiring (integration)
  // -----------------------------------------------------------------------

  describe('create-agent.ts wiring', () => {
    it('agent.status() returns { phase: "fresh" } when no h.store() session is configured', async () => {
      // arrange
      const h = createHarness()({}).loop(l =>
        l.start().step('go', { route: () => 'done' }).on('done').end()
      )
      const agent = createAgent('test-agent', h, {})

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
      const agent = createAgent('test-agent', h, {})

      // act
      await agent.status('session-abc')

      // assert
      expect(mockStore.load).toHaveBeenCalledOnce()
      expect(mockStore.load).toHaveBeenCalledWith('test-agent', 'session-abc')
    })

    it('agent.status() returns the mapped SessionPhase for a stored session', async () => {
      // arrange
      const mockStore = makeStubStore({
        load: vi.fn().mockResolvedValue({
          agentId: 'test-agent',
          runId: 'r1',
          sessionId: 'session-xyz',
          version: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          settledAt: '2026-01-01T00:01:00.000Z',
          phase: 'completed',
          initialState: {},
          finalState: {},
          signal: 'all-done',
        }),
      })
      const h = createHarness()({})
        .store({ session: mockStore })
        .loop(l => l.start().step('go', { route: () => 'done' }).on('done').end())
      const agent = createAgent('test-agent', h, {})

      // act
      const status = await agent.status('session-xyz')

      // assert
      expect(status).toEqual({ phase: 'completed', signal: 'all-done' })
    })
  })

  // -----------------------------------------------------------------------
  // Group: SessionRunOptions.observer threading
  // -----------------------------------------------------------------------

  describe('SessionRunOptions.observer threading', () => {
    it('runLoop receives callbacks.observer === obs when options.observer is set', async () => {
      // arrange
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-obs-thread' }
      const obs = { onRunStart: vi.fn(), onRunEnd: vi.fn() }
      let capturedCallbacks: Record<string, unknown> | undefined
      vi.spyOn(loopExecutorModule, 'runLoop').mockImplementationOnce(
        async (_graph, _state, _ctx, _schema, _shouldStop, _store, callbacks) => {
          capturedCallbacks = callbacks as Record<string, unknown>
          return { signal: 'done', state: {}, paused: false, cursor: null }
        }
      )

      // act
      await runWithSession(
        undefined, 'test-agent', 'sid-obs-thread', randomUUID(), graph, {}, undefined, ctx,
        { observer: obs }
      )

      // assert
      expect(capturedCallbacks).toBeDefined()
      expect((capturedCallbacks as any).observer).toBe(obs) // any: capturing untyped callbacks bag for assertion
    })

    it('callbacks.observer is absent (not set to undefined) when no observer in options', async () => {
      // arrange
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-no-obs' }
      let capturedCallbacks: Record<string, unknown> | undefined
      vi.spyOn(loopExecutorModule, 'runLoop').mockImplementationOnce(
        async (_graph, _state, _ctx, _schema, _shouldStop, _store, callbacks) => {
          capturedCallbacks = callbacks as Record<string, unknown>
          return { signal: 'done', state: {}, paused: false, cursor: null }
        }
      )

      // act
      await runWithSession(
        undefined, 'test-agent', 'sid-no-obs', randomUUID(), graph, {}, undefined, ctx,
        {}
      )

      // assert
      expect(capturedCallbacks).toBeDefined()
      expect('observer' in (capturedCallbacks ?? {})).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Group: SessionRunOptions.parentRunId threading
  // -----------------------------------------------------------------------

  describe('SessionRunOptions.parentRunId threading', () => {
    it('threads parentRunId from options to runLoop callbacks', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext for assertion
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-parent-thread' }

      // act
      await runWithSession(
        undefined, 'test-agent', 'sid-parent-thread', randomUUID(), graph, {}, undefined, ctx,
        { observer, parentRunId: 'parent-123' }
      )

      // assert
      expect(capturedCtx[0]!.parentRunId).toBe('parent-123')
    })

    it('omits parentRunId from RunContext when options.parentRunId is absent', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext for assertion
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-no-parent' }

      // act
      await runWithSession(
        undefined, 'test-agent', 'sid-no-parent', randomUUID(), graph, {}, undefined, ctx,
        { observer }
      )

      // assert
      expect(capturedCtx[0]!.parentRunId).toBeUndefined()
      expect('parentRunId' in capturedCtx[0]!).toBe(false)
    })

    it('preserves parentRunId across sequential calls with different values', async () => {
      // arrange
      const capturedCtx: RunContext[] = []
      const observer = { onRunStart: vi.fn((ctx: any) => capturedCtx.push(ctx)) } // any: capturing RunContext for assertion
      const graph = makeCompletingGraph()
      const ctx = { agentId: 'test-agent', sessionId: 'sid-sequence' }

      // act — first call with parentRunId
      await runWithSession(
        undefined, 'test-agent', 'sid-sequence', randomUUID(), graph, {}, undefined, ctx,
        { observer, parentRunId: 'parent-first' }
      )

      // second call without parentRunId (reusing same ctx and observer)
      await runWithSession(
        undefined, 'test-agent', 'sid-sequence', randomUUID(), graph, {}, undefined, ctx,
        { observer }
      )

      // assert
      expect(capturedCtx).toHaveLength(2)
      expect(capturedCtx[0]!.parentRunId).toBe('parent-first')
      expect(capturedCtx[1]!.parentRunId).toBeUndefined()
      expect('parentRunId' in capturedCtx[1]!).toBe(false)
    })
  })
})
