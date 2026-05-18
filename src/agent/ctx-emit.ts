import type { Observer, StepContext } from './observer.js'

/**
 * Create the ctx.emit function for a single runLoop invocation.
 * Returns a synchronous, fire-and-forget dispatcher.
 * Fires the matching listener (if registered) AND observer.onEvent (if observer
 * is set and stepCtxRef.current is non-null) independently for each call.
 */
export function createEmitFn(
  listeners: Record<string, (payload: unknown) => void>,
  observer?: Observer,
  stepCtxRef?: { current: StepContext | null },
): (name: string, payload?: unknown) => void {
  return (name: string, payload?: unknown): void => {
    listeners[name]?.(payload)
    if (observer !== undefined && stepCtxRef !== undefined && stepCtxRef.current !== null) {
      observer.onEvent?.(stepCtxRef.current, name, payload)
    }
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
