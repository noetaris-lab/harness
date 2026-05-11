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
  load(sessionId: string): Promise<StoredSession | null>
  save(sessionId: string, session: StoredSession): Promise<void>
}

// -----------------------------------------------------------------------
// StoredSession — the serialized session record
// -----------------------------------------------------------------------

export interface StoredSession {
  readonly phase: 'in-flight' | 'paused' | 'completed'
  readonly state: Record<string, unknown>
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

export function storedSessionToPhase(loaded: StoredSession | null): SessionPhase {
  if (loaded === null) {
    return { phase: 'fresh' }
  }

  if (loaded.phase === 'in-flight') {
    return { phase: 'in-flight', step: null }
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
  stored: StoredSession | null,
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
  stored: StoredSession,
  initialStateArg: Record<string, unknown>,
  argKeys: Set<string>,
  schema: SchemaLike | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...stored.state }

  // Apply initialStateArg fields on top of stored state
  for (const key of argKeys) {
    const fieldDef = schema?.[key]
    if (fieldDef?.reduce !== undefined) {
      result[key] = fieldDef.reduce(stored.state[key], initialStateArg[key])
    } else {
      result[key] = initialStateArg[key]
    }
  }

  // Apply schema defaults for keys absent from both stored.state and initialStateArg
  if (schema !== undefined) {
    for (const key of Object.keys(schema)) {
      if (argKeys.has(key)) continue
      if (key in stored.state) continue
      const field = schema[key]
      if (field !== undefined && field.default !== undefined) {
        result[key] = field.default()
      }
    }
  }

  return result
}
