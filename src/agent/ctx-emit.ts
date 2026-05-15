/**
 * Create the ctx.emit function for a single runLoop invocation.
 * Returns a synchronous, fire-and-forget dispatcher.
 * Calls the matching listener if registered; no-ops for unknown names.
 */
export function createEmitFn(
  listeners: Record<string, (payload: unknown) => void>,
): (name: string, payload?: unknown) => void {
  return (name: string, payload?: unknown): void => {
    listeners[name]?.(payload)
  }
}

/**
 * Extract the listeners map from agent.run() resources.
 * Returns an empty object if the 'listeners' key is absent or not a plain object.
 */
export function extractRunListeners(
  resources: Record<string, unknown>,
): Record<string, (payload: unknown) => void> {
  const raw = resources['listeners']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  // plain object: return as-is; listener values are not validated
  return raw as Record<string, (payload: unknown) => void> // as: duck-typed plain object confirmed above; values are caller's responsibility
}
