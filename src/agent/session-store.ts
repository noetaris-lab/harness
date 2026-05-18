type SchemaLike = Record<string, {
  readonly default?: (() => unknown) | undefined
  // any on reduce params: function parameter contravariance means typed reducers (e.g. (current: string[]) => string[])
  // are not assignable to (current: unknown) => unknown; any erases the bound safely for runtime use
  readonly reduce?: ((current: any, next: any) => unknown) | undefined // any: see above
}>

// -----------------------------------------------------------------------
// SessionStore — the persistence contract
// -----------------------------------------------------------------------

export interface SessionStore {
  load(agentId: string, sessionId: string): Promise<StoredRun | null>
  save(agentId: string, sessionId: string, run: StoredRun): Promise<void>
  loadHistory?(agentId: string, sessionId: string): Promise<StoredRun[]>
  branch?(agentId: string, sessionId: string, runId: string): Promise<string>
}

// -----------------------------------------------------------------------
// StoredRun — the per-run serialized record (replaces StoredSession)
// -----------------------------------------------------------------------

export interface StoredRun {
  readonly agentId: string
  readonly runId: string
  readonly sessionId: string
  readonly startedAt: string
  readonly settledAt: string
  readonly phase: 'paused' | 'completed'
  readonly initialState: Record<string, unknown>
  readonly finalState: Record<string, unknown>
  readonly signal?: string
  readonly step?: string
}

// -----------------------------------------------------------------------
// SessionPhase — the agent.status() query result
// -----------------------------------------------------------------------

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
