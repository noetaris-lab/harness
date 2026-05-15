/**
 * Framework-fired event callbacks for a single agent.run() invocation.
 * All fields are optional — omit any you do not need.
 * Callbacks are fire-and-forget; their return value is ignored.
 * Scoped to the run — released when the run settles.
 *
 * Note: user-emitted events (formerly onLlmCall etc.) are replaced by
 * ctx.emit(name, payload) + the 'listeners' resource key. See agent.md.
 */
export interface RunEvents {
  /** Called just before a step's run function is invoked. */
  onBeforeStep?: (name: string, state: Record<string, unknown>) => void
  /** Called just after a step's run function completes successfully (state update applied). */
  onAfterStep?: (name: string, state: Record<string, unknown>) => void
  /**
   * Called when the loop exits normally via .on(signal).end().
   * Not called for paused outcomes (stop, abort, error, interrupt).
   */
  onComplete?: (state: Record<string, unknown>, signal: string) => void
  /**
   * Called immediately when a step's run throws a non-interrupt error, before error routing.
   * Fires regardless of how the error is ultimately handled. Does not affect routing or state.
   */
  onError?: (error: unknown, stepName: string) => void
  /**
   * Called when ctx.interrupt() pauses the run (i.e. when isInterruptPause is true).
   * Fires with the prompt and interruptId from the InterruptPause exception, before the
   * run resolves with signal: "$interrupt".
   */
  onInterrupt?: (prompt: unknown, interruptId: string) => void
  /**
   * Called if the session store fails at load or persist phase.
   * phase: 'load' — store failed at run start (run never executed).
   * phase: 'persist' — store failed at run end (run completed but state not saved).
   */
  onStoreError?: (error: unknown, phase: 'load' | 'persist') => void
}

/**
 * Extract and validate the events object from agent.run() resources.
 * Returns an empty RunEvents if no events key is present.
 */
export function extractRunEvents(resources: Record<string, unknown>): RunEvents {
  const raw = resources['events']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  // plain object: return as-is; callbacks are optional and missing keys are undefined
  return raw as RunEvents // as: duck-typed plain object confirmed above; RunEvents fields are all optional
}
