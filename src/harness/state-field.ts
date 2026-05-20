// Phantom symbol — never accessible at runtime; required for reliable T inference
// even when neither `default` nor `reduce` is provided
declare const _fieldType: unique symbol

/**
 * Descriptor for a single state field, produced by {@link field}.
 *
 * - `default` — factory called once on session start to populate the field when no
 *   initial value is supplied.
 * - `reduce` — merge function invoked on resume: `reduce(storedValue, incomingValue)`.
 *   When absent, incoming values overwrite stored ones on resume.
 */
export type FieldDefinition<T> = {
  readonly [_fieldType]: T
  readonly default?: () => T
  readonly reduce?: (current: T, update: T) => T
}

/**
 * Derives the concrete state record type from a schema object whose values are
 * {@link FieldDefinition} descriptors.
 *
 * @example
 * ```ts
 * const schema = { count: field<number>({ default: () => 0 }) }
 * type State = StateFromSchema<typeof schema> // { count: number }
 * ```
 */
// use FieldDefinition<any> in bounds, not FieldDefinition<unknown> — reduce makes T invariant
export type StateFromSchema<S> = {
  [K in keyof S]: S[K] extends FieldDefinition<infer T> ? T : never
}

type FieldOptions<T> = {
  default?: () => T
  reduce?: (current: T, update: T) => T
}

/**
 * Declare a typed state field with an optional default factory and optional
 * reduce function.
 *
 * @param options.default - Factory called once at session start.
 * @param options.reduce - Merge function for resume: `(stored, incoming) => merged`.
 *
 * @example
 * ```ts
 * const schema = {
 *   messages: field<string[]>({ default: () => [], reduce: (a, b) => [...a, ...b] }),
 * }
 * ```
 */
export function field<T>(options?: FieldOptions<T>): FieldDefinition<T> {
  return { ...options } as FieldDefinition<T> // as: phantom [_fieldType] is type-level only; the runtime object can never carry the symbol property
}
