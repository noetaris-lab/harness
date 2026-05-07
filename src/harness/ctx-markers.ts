export const REQUIRED_TAG = '__noetaris_required__' as const
export const RUNTIME_TAG = '__noetaris_runtime__' as const

// string literal _tag is the sole type-level discriminant; phantom symbols were tried but
// TypeScript does not enforce non-exported unique symbol keys across module boundaries
export type RequiredMarker = { readonly _tag: typeof REQUIRED_TAG }
export type RuntimeMarker = { readonly _tag: typeof RUNTIME_TAG }

// object branch includes | RequiredMarker | RuntimeMarker so a top-level marker is accepted
// where DeepWithMarkers<T> is expected (e.g. h.provide('slot', required()) on an object slot)
export type DeepWithMarkers<T> =
  T extends object
    ? { [K in keyof T]: DeepWithMarkers<T[K]> | RequiredMarker | RuntimeMarker } | RequiredMarker | RuntimeMarker
    : T | RequiredMarker | RuntimeMarker

export function required(): RequiredMarker {
  return { _tag: REQUIRED_TAG }
}

export function runtime(): RuntimeMarker {
  return { _tag: RUNTIME_TAG }
}

export function isRequiredMarker(value: unknown): value is RequiredMarker {
  return value !== null && typeof value === 'object' && '_tag' in value && value._tag === REQUIRED_TAG
}

export function isRuntimeMarker(value: unknown): value is RuntimeMarker {
  return value !== null && typeof value === 'object' && '_tag' in value && value._tag === RUNTIME_TAG
}
