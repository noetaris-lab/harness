import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SessionStore, StoredRun, Lease } from './session-store.js'
import { createAgent } from './create-agent.js'
import { createHarness } from '../harness/harness-builder.js'
import type { LoopBuilder } from '../loop/loop-dsl.js'
import {
  SessionBusyError,
  StoreLoadError,
  LeaseExpiredError,
} from './concurrency-errors.js'

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
// Loop helpers
// -----------------------------------------------------------------------

function buildCompletingLoop<S, Ctx>(l: LoopBuilder<S, Ctx>): void {
  l.start()
    .step('go', { run: async () => ({}), route: () => 'done' })
    .on('done').end()
}

// -----------------------------------------------------------------------
// Group 1: instanceId propagation
// -----------------------------------------------------------------------

describe('ClaimLifecycle — instanceId propagation', () => {
  it('Case 1.1: RunContext.instanceId equals "pod-1" when createAgent receives instanceId option', async () => {
    const onRunStart = vi.fn()
    const h = createHarness<Record<string, never>>()().loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {}, { instanceId: 'pod-1' })

    const outcome = await agent.run({}, { observer: { onRunStart } })

    expect(onRunStart).toHaveBeenCalledOnce()
    expect(onRunStart.mock.calls[0]![0]).toMatchObject({ agentId: 'agent-1', instanceId: 'pod-1' })
    expect(outcome.signal).toBe('done')
  })

  it('Case 1.2: RunContext.instanceId is absent when createAgent has no options', async () => {
    const onRunStart = vi.fn()
    const h = createHarness<Record<string, never>>()().loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, { observer: { onRunStart } })

    expect(onRunStart).toHaveBeenCalledOnce()
    expect(onRunStart.mock.calls[0]![0]).not.toHaveProperty('instanceId')
  })

  it('Case 1.3: StoredRun.metadata.instanceId equals "pod-1" from AgentOptions even when Lease omits instanceId', async () => {
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {}, { instanceId: 'pod-1' })

    await agent.run({}, {})

    expect(store.save).toHaveBeenCalledOnce()
    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
    expect(saved.metadata).toEqual({ instanceId: 'pod-1' })
  })

  it('Case 1.4: StoredRun has no metadata property when createAgent has no instanceId', async () => {
    const store = makeStubStore()
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, {})

    expect(store.save).toHaveBeenCalledOnce()
    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![2] as StoredRun
    expect(saved).not.toHaveProperty('metadata')
  })
})

// -----------------------------------------------------------------------
// Group 2: claim/release lifecycle
// -----------------------------------------------------------------------

describe('ClaimLifecycle — claim/release lifecycle', () => {
  it('Case 2.1: store.claim is called with agentId, sessionId, and claimOptions; store.release is called after run settles', async () => {
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, { sessionId: 'sess-42' })

    expect(store.claim).toHaveBeenCalledOnce()
    expect(store.claim).toHaveBeenCalledWith('agent-1', 'sess-42', expect.objectContaining({ ttlMs: expect.any(Number) }))
    expect(store.release).toHaveBeenCalledOnce()
    expect(store.release).toHaveBeenCalledWith(lease)
    expect((store.claim as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (store.load as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    )
  })

  it('Case 2.2: store.claim receives claimOptions.ttlMs from resources when provided', async () => {
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, { claimOptions: { ttlMs: 60_000 } })

    expect(store.claim).toHaveBeenCalledWith(expect.any(String), expect.any(String), { ttlMs: 60_000 })
  })

  it('Case 2.3: store.claim receives default { ttlMs: 30_000 } when claimOptions is absent from resources', async () => {
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, {})

    expect(store.claim).toHaveBeenCalledWith(expect.any(String), expect.any(String), { ttlMs: 30_000 })
  })

  it('Case 2.4: run proceeds normally when store has no claim() method', async () => {
    const store = makeStubStore()
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    const outcome = await agent.run({}, {})

    expect(outcome.signal).toBe('done')
    expect(store.save).toHaveBeenCalledOnce()
  })

  it('Case 2.5: store.release() rejection is swallowed, run outcome unchanged, and inFlightSessions is still cleaned up', async () => {
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockRejectedValue(new Error('network timeout')),
    })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    const first = await agent.run({}, { sessionId: 'sess-rel-fail' })
    const second = await agent.run({}, { sessionId: 'sess-rel-fail' })

    expect(first.signal).toBe('done')
    expect(store.release).toHaveBeenCalledTimes(2)
    expect(second.signal).toBe('done')
  })
})

// -----------------------------------------------------------------------
// Group 3: ctx.keepAlive injection
// -----------------------------------------------------------------------

describe('ClaimLifecycle — ctx.keepAlive injection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Case 3.1: await ctx.keepAlive() updates leaseRef.current so a second call uses the renewed lease', async () => {
    const initialLease = { expiresAt: Date.now() + 60_000 } as Lease
    const renewedLease = { expiresAt: Date.now() + 90_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(initialLease),
      release: vi.fn().mockResolvedValue(undefined),
      extendClaim: vi.fn().mockResolvedValue(renewedLease),
    })
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', {
            run: async (_s, ctx) => {
              await (ctx as Record<string, unknown> & { keepAlive: () => Promise<void> }).keepAlive()
              await (ctx as Record<string, unknown> & { keepAlive: () => Promise<void> }).keepAlive()
              return {}
            },
            route: () => 'done',
          })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, { claimOptions: { ttlMs: 45_000 } })

    expect(store.extendClaim).toHaveBeenCalledTimes(2)
    expect(store.extendClaim).toHaveBeenNthCalledWith(1, initialLease, { ttlMs: 45_000 })
    expect(store.extendClaim).toHaveBeenNthCalledWith(2, renewedLease, { ttlMs: 45_000 })
  })

  it('Case 3.2: ctx.keepAlive({ every: 100 }) causes store.extendClaim to be called while the step is still executing', async () => {
    vi.useFakeTimers()
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const renewedLease = { expiresAt: Date.now() + 90_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockResolvedValue(undefined),
      extendClaim: vi.fn().mockResolvedValue(renewedLease),
    })

    let resolveStep!: () => void
    const stepGate = new Promise<void>((r) => { resolveStep = r })

    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', {
            run: async (_s, ctx) => {
              ;(ctx as Record<string, unknown> & { keepAlive: (opts: { every: number }) => void }).keepAlive({ every: 100 })
              await stepGate
              return {}
            },
            route: () => 'done',
          })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    const runPromise = agent.run({}, {})
    await vi.advanceTimersByTimeAsync(350)
    resolveStep()
    await runPromise

    expect(store.extendClaim).toHaveBeenCalledTimes(3)
    expect(store.extendClaim).toHaveBeenCalledWith(lease, expect.objectContaining({ ttlMs: 30_000 }))
  })

  it('Case 3.3: ctx.keepAlive() resolves immediately without throwing when no claim is active', async () => {
    const store = makeStubStore()
    let keepAliveError: unknown = null
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', {
            run: async (_s, ctx) => {
              try { await (ctx as Record<string, unknown> & { keepAlive: () => Promise<void> }).keepAlive() }
              catch (e) { keepAliveError = e }
              return {}
            },
            route: () => 'done',
          })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    const outcome = await agent.run({}, {})

    expect(keepAliveError).toBeNull()
    expect(outcome.signal).toBe('done')
  })

  it('Case 3.4: ctx.keepAlive({ every: ms }) is a no-op and fires no timers when store has no claim()', async () => {
    vi.useFakeTimers()
    const store = makeStubStore({ extendClaim: vi.fn() })
    let keepAliveError: unknown = null
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', {
            run: async (_s, ctx) => {
              try { ;(ctx as Record<string, unknown> & { keepAlive: (opts: { every: number }) => void }).keepAlive({ every: 50 }) }
              catch (e) { keepAliveError = e }
              return {}
            },
            route: () => 'done',
          })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    const runPromise = agent.run({}, {})
    await vi.advanceTimersByTimeAsync(200)
    await runPromise

    expect(keepAliveError).toBeNull()
    expect(store.extendClaim).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------
// Group 4: claim() failure — busy and exception
// -----------------------------------------------------------------------

describe('ClaimLifecycle — claim() failure', () => {
  it('Case 4.1: store.claim() returns null → run resolves with signal \'$error\', SessionBusyError, and onStoreError(\'claim\')', async () => {
    const onStoreError = vi.fn()
    const store = makeStubStore({ claim: vi.fn().mockResolvedValue(null) })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    const outcome = await agent.run({}, { sessionId: 'sess-busy', events: { onStoreError } })

    expect(outcome.signal).toBe('$error')
    expect(outcome.state['$error']).toBeInstanceOf(SessionBusyError)
    expect((outcome.state['$error'] as SessionBusyError).sessionId).toBe('sess-busy')
    expect(onStoreError).toHaveBeenCalledOnce()
    expect(onStoreError).toHaveBeenCalledWith(expect.any(SessionBusyError), 'claim')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('Case 4.2: inFlightSessions is cleaned up after claim() returns null — second run on same sessionId does not throw SessionInFlightError', async () => {
    let callCount = 0
    const store = makeStubStore({
      claim: vi.fn().mockImplementation(() => { callCount++; return Promise.resolve(null) }),
    })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    const first = await agent.run({}, { sessionId: 'sess-retry' })
    const second = await agent.run({}, { sessionId: 'sess-retry' })

    expect(first.signal).toBe('$error')
    expect(first.state['$error']).toBeInstanceOf(SessionBusyError)
    expect(second.signal).toBe('$error')
    expect(second.state['$error']).toBeInstanceOf(SessionBusyError)
    expect(callCount).toBe(2)
  })

  it('Case 4.3: store.claim() rejection (throws) → run resolves with signal \'$error\', StoreLoadError wrapping original, and onStoreError(\'claim\')', async () => {
    const networkError = new Error('connection reset')
    const onStoreError = vi.fn()
    const store = makeStubStore({ claim: vi.fn().mockRejectedValue(networkError) })
    const h = createHarness<Record<string, never>>()().store({ session: store }).loop(buildCompletingLoop)
    const agent = createAgent('agent-1', h, {})

    const outcome = await agent.run({}, { events: { onStoreError } })

    expect(outcome.signal).toBe('$error')
    expect(outcome.state['$error']).toBeInstanceOf(StoreLoadError)
    expect((outcome.state['$error'] as StoreLoadError).cause).toBe(networkError)
    expect(onStoreError).toHaveBeenCalledOnce()
    expect(onStoreError).toHaveBeenCalledWith(expect.any(StoreLoadError), 'claim')
    expect(store.save).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------
// Group 5: Lease expiry
// -----------------------------------------------------------------------

describe('ClaimLifecycle — lease expiry', () => {
  it('Case 5.1: onStoreError(leaseExpiredError, \'claim\') is called and store.save is not called when lease expiresAt has elapsed', async () => {
    const onStoreError = vi.fn()
    const expiredLease = { expiresAt: Date.now() - 1 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(expiredLease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    await agent.run({}, { sessionId: 'sess-exp', events: { onStoreError } })

    expect(onStoreError).toHaveBeenCalledOnce()
    expect(onStoreError).toHaveBeenCalledWith(expect.any(LeaseExpiredError), 'claim')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('Case 5.2: RunHandle resolves with signal \'$error\' and LeaseExpiredError when lease expires', async () => {
    const expiredLease = { expiresAt: Date.now() - 1 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(expiredLease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    const outcome = await agent.run({}, { sessionId: 'sess-exp' })

    expect(outcome.signal).toBe('$error')
    expect(outcome.state['$error']).toBeInstanceOf(LeaseExpiredError)
    expect((outcome.state['$error'] as LeaseExpiredError).sessionId).toBe('sess-exp')
  })

  it('Case 5.3: store.save is called as paused and store.release is called when run stops normally (not expiry)', async () => {
    const futureLease = { expiresAt: Date.now() + 60_000 } as Lease
    const store = makeStubStore({
      claim: vi.fn().mockResolvedValue(futureLease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('go', { run: async () => ({}), route: () => 'done' })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})
    const ac = new AbortController()
    ac.abort()

    const outcome = await agent.run({}, { signal: ac.signal })

    expect(outcome.signal).toBe(null) // signal: null means loop stopped normally (not expiry/$error)
    expect(store.save).toHaveBeenCalledOnce()
    expect(store.release).toHaveBeenCalledOnce()
    expect(store.release).toHaveBeenCalledWith(futureLease)
    expect((store.save as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (store.release as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    )
  })
})

// -----------------------------------------------------------------------
// Group 6: Cross-process resume
// -----------------------------------------------------------------------

describe('ClaimLifecycle — cross-process resume', () => {
  it('Case 6.1: agent.resume() calls store.claim before runWithSession and store.release after', async () => {
    const lease = { expiresAt: Date.now() + 60_000 } as Lease
    const interruptedRun: StoredRun = {
      agentId: 'agent-1',
      sessionId: 'sess-resume',
      runId: 'run-0',
      version: 0,
      phase: 'paused',
      startedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      initialState: {},
      finalState: {
        $interrupt: { interruptId: '$auto:0', prompt: 'q?' },
        $interruptResponses: {},
        $cursor: 'step2',
      },
      step: 'step2',
      signal: '$interrupt',
    }
    const store = makeStubStore({
      load: vi.fn().mockResolvedValue(interruptedRun),
      claim: vi.fn().mockResolvedValue(lease),
      release: vi.fn().mockResolvedValue(undefined),
    })
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('step1', { run: async () => ({}), route: () => 'done' })
          .on('done').to('step2')
          .step('step2', {
            run: async (_s, ctx) => { await ctx.interrupt('q?'); return {} },
            route: () => 'done',
          })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    await agent.resume('my-answer', 'sess-resume', '$auto:0')

    expect(store.claim).toHaveBeenCalledOnce()
    expect(store.claim).toHaveBeenCalledWith('agent-1', 'sess-resume', expect.objectContaining({ ttlMs: 30_000 }))
    expect(store.release).toHaveBeenCalledOnce()
    expect(store.release).toHaveBeenCalledWith(lease)
  })

  it('Case 6.2: agent.resume() resolves with SessionBusyError when store.claim() returns null', async () => {
    const interruptedRun: StoredRun = {
      agentId: 'agent-1',
      sessionId: 'sess-resume',
      runId: 'run-0',
      version: 0,
      phase: 'paused',
      startedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      initialState: {},
      finalState: {
        $interrupt: { interruptId: '$auto:0', prompt: 'q?' },
        $interruptResponses: {},
        $cursor: 'step2',
      },
      step: 'step2',
      signal: '$interrupt',
    }
    const onStoreError = vi.fn()
    const store = makeStubStore({
      load: vi.fn().mockResolvedValue(interruptedRun),
      claim: vi.fn().mockResolvedValue(null),
    })
    const h = createHarness<Record<string, never>>()()
      .store({ session: store })
      .loop((l) => {
        l.start()
          .step('step1', { run: async () => ({}), route: () => 'done' })
          .on('done').to('step2')
          .step('step2', {
            run: async (_s, ctx) => { await ctx.interrupt('q?'); return {} },
            route: () => 'done',
          })
          .on('done').end()
      })
    const agent = createAgent('agent-1', h, {})

    const outcome = await agent.resume('my-answer', 'sess-resume', '$auto:0', { events: { onStoreError } })

    expect(outcome.signal).toBe('$error')
    expect(outcome.state['$error']).toBeInstanceOf(SessionBusyError)
    expect((outcome.state['$error'] as SessionBusyError).sessionId).toBe('sess-resume')
    expect(onStoreError).toHaveBeenCalledOnce()
    expect(onStoreError).toHaveBeenCalledWith(expect.any(SessionBusyError), 'claim')
  })
})
