// Phantom symbol — never accessible at runtime; required for reliable T inference
// even when neither `default` nor `reduce` is provided
declare const _fieldType: unique symbol

export type FieldDefinition<T> = {
  readonly [_fieldType]: T
  readonly default?: () => T
  readonly reduce?: (current: T, update: T) => T
}

// use FieldDefinition<any> in bounds, not FieldDefinition<unknown> — reduce makes T invariant
export type StateFromSchema<S> = {
  [K in keyof S]: S[K] extends FieldDefinition<infer T> ? T : never
}

type FieldOptions<T> = {
  default?: () => T
  reduce?: (current: T, update: T) => T
}

export function field<T>(options?: FieldOptions<T>): FieldDefinition<T> {
  return { ...options } as FieldDefinition<T> // as: phantom [_fieldType] is type-level only; the runtime object can never carry the symbol property
}
