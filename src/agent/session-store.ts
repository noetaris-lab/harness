type SchemaLike = Record<string, {
  readonly default?: (() => unknown) | undefined
  // any on reduce params: function parameter contravariance means typed reducers (e.g. (current: string[]) => string[])
  // are not assignable to (current: unknown) => unknown; any erases the bound safely for runtime use
  readonly reduce?: ((current: any, next: any) => unknown) | undefined // any: see above
}>

// -----------------------------------------------------------------------
// ClaimOptions — lease duration passed to claim() and extendClaim()
// -----------------------------------------------------------------------

/**
 * Options passed to {@link SessionStore.claim}.
 *
 * `ttlMs` is the initial lease duration in milliseconds. The claim expires
 * if not renewed within this window — enabling crash recovery by other instances.
 */
export interface ClaimOptions {
  /** Lease duration in milliseconds. Must be a positive integer. */
  readonly ttlMs: number
}

// -----------------------------------------------------------------------
// Lease — distributed lease handle returned by claim() and extendClaim()
// -----------------------------------------------------------------------

/**
 * A successfully acquired distributed lease on a session.
 *
 * Returned by {@link SessionStore.claim} when no other instance holds the
 * session. The framework holds this object for the duration of the run and
 * passes it to {@link SessionStore.release} and {@link SessionStore.extendClaim}.
 */
export interface Lease {
  /**
   * Wall-clock expiry timestamp (milliseconds since epoch).
   * The framework checks `Date.now() >= lease.expiresAt` at each step boundary
   * to detect TTL expiry without contacting the store.
   */
  readonly expiresAt: number
  /**
   * The `agentId` this lease was issued for.
   * Stored in the claim record for stuck-lease diagnosis.
   */
  readonly agentId: string
  /**
   * The `sessionId` this lease covers.
   */
  readonly sessionId: string
  /**
   * The `instanceId` of the holder, if provided to `createAgent()`.
   * Written into the store's claim record for operational diagnostics.
   * Absent when `instanceId` was not configured.
   */
  readonly instanceId?: string
  /**
   * Store-implementation-specific token — e.g. a Redis key name, a lock token,
   * or a database row ID. Opaque to the framework; passed back unmodified on
   * `release` and `extendClaim` calls so the store can locate the record.
   */
  readonly token: unknown
}

// -----------------------------------------------------------------------
// StoredRunMetadata — operational metadata written into StoredRun
// -----------------------------------------------------------------------

/**
 * Operational metadata written by the framework into every {@link StoredRun}.
 *
 * The framework writes only `instanceId`. All other fields are reserved for
 * domain-specific operational annotations (tenantId, region, requestId, etc.).
 */
export interface StoredRunMetadata {
  /** The `instanceId` of the instance that produced this run. Absent when not configured. */
  instanceId?: string
  /** Open extension point — domain-specific fields. */
  [key: string]: unknown
}

// -----------------------------------------------------------------------
// SessionStore — the persistence contract
// -----------------------------------------------------------------------

/**
 * Persistence contract for agent sessions.
 *
 * Implementations must be safe to call concurrently for **different** sessions;
 * concurrent calls for the **same** session are prevented by the harness concurrency guards.
 *
 * `loadHistory` and `branch` are optional extensions:
 * - `loadHistory` — full run history for a session (used by branching and debugging tools).
 * - `branch` — fork a session at a specific past run, returning a new session ID.
 */
export interface SessionStore {
  /**
   * Load the most recent {@link StoredRun} for the given session, or `null` if
   * the session has never been saved.
   */
  load(agentId: string, sessionId: string): Promise<StoredRun | null>

  /**
   * Persist a run record as a conditional write.
   *
   * Implementations must compare `run.version` against the version of the
   * currently stored record before writing:
   * - If the stored version equals `run.version - 1` (or there is no stored
   *   record and `run.version === 0`), the write succeeds.
   * - Otherwise, another writer committed a newer version concurrently — the
   *   implementation must throw `ConcurrentModificationError`.
   */
  save(agentId: string, sessionId: string, run: StoredRun): Promise<void>

  /**
   * Return the full ordered run history for a session, oldest first.
   * Optional — omit if your store does not support history.
   */
  loadHistory?(agentId: string, sessionId: string): Promise<StoredRun[]>

  /**
   * Fork the session at the state captured by `runId`, returning a new session ID
   * whose initial state equals the forked run's `finalState`.
   * Optional — omit if your store does not support branching.
   *
   * @throws {@link BranchNotFoundError} when `runId` is not found in history.
   */
  branch?(agentId: string, sessionId: string, runId: string): Promise<string>

  /**
   * Attempt to acquire a distributed claim on the session before starting a run.
   *
   * - Returns a {@link Lease} when the claim is acquired.
   * - Returns `null` when another instance already holds the claim — the framework
   *   throws {@link SessionBusyError} immediately without starting any LLM work.
   *
   * Optional — stores that do not support distributed locking omit this method.
   * The framework checks for its presence before calling it.
   */
  claim?(agentId: string, sessionId: string, options: ClaimOptions): Promise<Lease | null>

  /**
   * Release a held claim after the run settles.
   *
   * Called by the framework after `save()` completes (or after an error that
   * prevents saving). Stores may use this to remove the lock record immediately
   * rather than waiting for TTL expiry.
   *
   * Optional — omit if your store does not support claim/release.
   */
  release?(lease: Lease): Promise<void>

  /**
   * Extend the TTL of an active claim.
   *
   * Called by `ctx.keepAlive()` (both one-shot and background interval modes).
   * The store must update `expiresAt` on the claim record; the new expiry is
   * `Date.now() + options.ttlMs`. The returned `Lease` object carries the updated
   * `expiresAt`; the framework replaces its held reference with the returned value.
   *
   * Optional — omit if your store does not support claim/release.
   */
  extendClaim?(lease: Lease, options: ClaimOptions): Promise<Lease>
}

// -----------------------------------------------------------------------
// StoredRun — the per-run serialized record (replaces StoredSession)
// -----------------------------------------------------------------------

/**
 * Serializable snapshot of a single agent run, written to the store after
 * every run settles (either `'paused'` on an interrupt or `'completed'`).
 *
 * - `phase: 'paused'` — the run paused on an interrupt; `step` is the step that
 *   issued the interrupt and `signal` is `'$interrupt'`.
 * - `phase: 'completed'` — the loop exited normally; `signal` holds the exit
 *   signal (or is absent when the loop ended without emitting a signal).
 */
export interface StoredRun {
  readonly agentId: string
  readonly runId: string
  readonly sessionId: string
  readonly version: number
  readonly startedAt: string
  readonly settledAt: string
  readonly phase: 'paused' | 'completed'
  readonly initialState: Record<string, unknown>
  readonly finalState: Record<string, unknown>
  readonly signal?: string
  readonly step?: string
  /**
   * Operational metadata written by the framework.
   *
   * The framework writes `instanceId` when configured; all other fields are
   * domain-defined. Absent for runs produced before this field was added.
   */
  readonly metadata?: StoredRunMetadata
}

// -----------------------------------------------------------------------
// SessionPhase — the agent.status() query result
// -----------------------------------------------------------------------

/**
 * Discriminated union returned by {@link Agent.status} describing the lifecycle
 * phase of a session.
 *
 * - `'fresh'` — no run has been stored yet.
 * - `'in-flight'` — a run is currently executing (in-process guard only; not
 *   detectable cross-process from the store alone).
 * - `'paused'` — the last run settled on an interrupt; `step` identifies the
 *   step that issued the interrupt.
 * - `'completed'` — the last run exited the loop; `signal` is the exit signal.
 */
export type SessionPhase =
  | { readonly phase: 'fresh' }
  | { readonly phase: 'in-flight'; readonly step: null }
  | { readonly phase: 'paused'; readonly signal?: string; readonly step: string }
  | { readonly phase: 'completed'; readonly signal?: string }

// -----------------------------------------------------------------------
// storedSessionToPhase — converts a raw load result to SessionPhase
// -----------------------------------------------------------------------

export function storedSessionToPhase(loaded: StoredRun | null): SessionPhase {
  if (loaded === null) {
    return { phase: 'fresh' }
  }

  if (loaded.phase === 'paused') {
    const step = loaded.step ?? ''
    if (loaded.signal !== undefined) {
      return { phase: 'paused', step, signal: loaded.signal }
    }
    return { phase: 'paused', step }
  }

  // completed
  if (loaded.signal !== undefined) {
    return { phase: 'completed', signal: loaded.signal }
  }
  return { phase: 'completed' }
}

// -----------------------------------------------------------------------
// initializeState — state merge for fresh sessions and resumptions
// -----------------------------------------------------------------------

export function initializeState(
  stored: StoredRun | null,
  initialStateArg: Record<string, unknown>,
  schema: SchemaLike | undefined,
): Record<string, unknown> {
  const argKeys = new Set(Object.keys(initialStateArg))

  if (stored === null) {
    return buildFreshState(initialStateArg, argKeys, schema)
  }

  return buildResumedState(stored, initialStateArg, argKeys, schema)
}

function buildFreshState(
  initialStateArg: Record<string, unknown>,
  argKeys: Set<string>,
  schema: SchemaLike | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...initialStateArg }

  if (schema === undefined || Object.keys(schema).length === 0) {
    return result
  }

  for (const key of Object.keys(schema)) {
    if (argKeys.has(key)) {
      // initialStateArg wins — already in result via spread
      continue
    }
    const field = schema[key]
    if (field !== undefined && field.default !== undefined) {
      result[key] = field.default()
    }
  }

  return result
}

function buildResumedState(
  stored: StoredRun,
  initialStateArg: Record<string, unknown>,
  argKeys: Set<string>,
  schema: SchemaLike | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...stored.finalState }

  // Apply initialStateArg fields on top of stored state
  for (const key of argKeys) {
    const fieldDef = schema?.[key]
    if (fieldDef?.reduce !== undefined) {
      result[key] = fieldDef.reduce(stored.finalState[key], initialStateArg[key])
    } else {
      result[key] = initialStateArg[key]
    }
  }

  // Apply schema defaults for keys absent from both stored.finalState and initialStateArg
  if (schema !== undefined) {
    for (const key of Object.keys(schema)) {
      if (argKeys.has(key)) continue
      if (key in stored.finalState) continue
      const field = schema[key]
      if (field !== undefined && field.default !== undefined) {
        result[key] = field.default()
      }
    }
  }

  return result
}
