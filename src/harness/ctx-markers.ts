/** @internal Discriminant tag for {@link RequiredMarker}. */
export const REQUIRED_TAG = '__noetaris_required__' as const
/** @internal Discriminant tag for {@link RuntimeMarker}. */
export const RUNTIME_TAG = '__noetaris_runtime__' as const

// string literal _tag is the sole type-level discriminant; phantom symbols were tried but
// TypeScript does not enforce non-exported unique symbol keys across module boundaries

/**
 * Sentinel returned by {@link required} to mark a context slot that **must** be
 * supplied at `createAgent()` time (not at `agent.run()` time).
 */
export type RequiredMarker = { readonly _tag: typeof REQUIRED_TAG }

/**
 * Sentinel returned by {@link runtime} to mark a context slot that **must** be
 * supplied at `agent.run()` time (not at `createAgent()` time).
 */
export type RuntimeMarker = { readonly _tag: typeof RUNTIME_TAG }

// function guard prevents TypeScript from recursing into Function's own method properties
// (call, bind, apply, etc.) when T is a function type, which would make the mapped type
// unresolvable and break @ts-expect-error enforcement on concrete value checks
/**
 * Recursive variant of `T` that allows any nested position to also be a
 * {@link RequiredMarker} or {@link RuntimeMarker}.  Used as the `value`
 * parameter type on {@link Harness.provide}.
 */
export type DeepWithMarkers<T> =
  T extends (...args: any[]) => any
    ? T | RequiredMarker | RuntimeMarker
    : T extends object
      ? { [K in keyof T]: DeepWithMarkers<T[K]> | RequiredMarker | RuntimeMarker } | RequiredMarker | RuntimeMarker
      : T | RequiredMarker | RuntimeMarker

/**
 * Return a {@link RequiredMarker} sentinel that instructs the harness to
 * require this slot at `createAgent()` time.
 *
 * @example
 * ```ts
 * h.provide('llm', required())
 * ```
 */
export function required(): RequiredMarker {
  return { _tag: REQUIRED_TAG }
}

/**
 * Return a {@link RuntimeMarker} sentinel that instructs the harness to
 * require this slot at `agent.run()` time instead of `createAgent()` time.
 *
 * @example
 * ```ts
 * h.provide('signal', runtime())
 * ```
 */
export function runtime(): RuntimeMarker {
  return { _tag: RUNTIME_TAG }
}

/**
 * Type guard — returns `true` when `value` is a {@link RequiredMarker}.
 */
export function isRequiredMarker(value: unknown): value is RequiredMarker {
  return value !== null && typeof value === 'object' && '_tag' in value && value._tag === REQUIRED_TAG
}

/**
 * Type guard — returns `true` when `value` is a {@link RuntimeMarker}.
 */
export function isRuntimeMarker(value: unknown): value is RuntimeMarker {
  return value !== null && typeof value === 'object' && '_tag' in value && value._tag === RUNTIME_TAG
}
