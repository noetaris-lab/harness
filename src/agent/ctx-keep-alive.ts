import type { SessionStore, Lease } from './session-store.js'

/**
 * A mutable reference to the currently held lease.
 * `null` when claim/lease is not in use (no-store or store without claim()).
 * Updated in-place by `extendClaim()` responses.
 */
export type LeaseRef = { current: Lease | null }

/**
 * Options for background renewal mode.
 */
export interface KeepAliveOptions {
  /**
   * Renewal interval in milliseconds. A background timer calls
   * `store.extendClaim()` at this cadence.
   * Must be less than the original claim `ttlMs` to ensure renewal
   * reaches the store before expiry.
   */
  readonly every: number
}

/**
 * The stop function returned by `ctx.keepAlive({ every })`.
 * Always call this in a `finally` block to cancel the background timer.
 */
export type StopFn = () => void

/**
 * The `ctx.keepAlive` function type injected into the step ctx.
 *
 * - Called with no arguments: one-shot TTL extension. Returns a Promise.
 * - Called with `{ every: ms }`: starts a background interval renewal timer.
 *   Returns a `StopFn` synchronously.
 */
export type KeepAliveFn =
  ((() => Promise<void>) & ((options: KeepAliveOptions) => StopFn))

/**
 * Create the `ctx.keepAlive` function for a single run.
 *
 * @param leaseRef      - Mutable reference to the active lease.
 * @param store         - The session store, or `undefined` when no store configured.
 * @param originalTtlMs - The `ttlMs` from the `ClaimOptions` used in the initial claim.
 * @returns The `keepAlive` function to inject into step `ctx`.
 */
export function createKeepAliveFn(
  leaseRef: LeaseRef,
  store: SessionStore | undefined,
  originalTtlMs: number,
): KeepAliveFn {
  function keepAlive(options?: KeepAliveOptions): Promise<void> | StopFn {
    const isBackground = typeof options === 'object' && options !== null && 'every' in options
    const extendClaim = store?.extendClaim

    if (isBackground) {
      // background renewal mode
      if (leaseRef.current === null || typeof extendClaim !== 'function') {
        // no-op: no active lease or store doesn't support extendClaim
        return noopStop
      }

      let handle: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (leaseRef.current === null) {
          // lease was released after timer started — skip but keep timer running
          return
        }
        // swallow errors — timer must continue regardless of extendClaim failures
        void (async () => {
          try {
            const renewed = await extendClaim.call(store, leaseRef.current!, { ttlMs: originalTtlMs })
            leaseRef.current = renewed
          } catch {
            /* swallow: expiry check at step boundary is the safety net */
          }
        })()
      }, options.every)

      return function stop() {
        if (handle !== null) {
          clearInterval(handle)
          handle = null
        }
      }
    }

    // one-shot mode
    if (leaseRef.current === null || typeof extendClaim !== 'function') {
      return Promise.resolve()
    }

    const snapshot = leaseRef.current
    return (async () => {
      const renewed = await extendClaim.call(store, snapshot, { ttlMs: originalTtlMs })
      leaseRef.current = renewed
    })()
  }

  // as: overloaded function — runtime discriminates on options presence
  return keepAlive as KeepAliveFn
}

function noopStop(): void {
  // no-op stop: no timer was started
}
