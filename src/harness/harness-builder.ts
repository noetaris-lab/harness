import type { FieldDefinition, StateFromSchema } from './state-field.js'
import type { RequiredMarker, RuntimeMarker, DeepWithMarkers } from './ctx-markers.js'
import type { LoopBuilder, LoopDefinition } from '../loop/loop-dsl.js'
import { createLoopBuilder, extractLoopDefinition } from '../loop/loop-dsl.js'
import { validateLoop } from '../loop/loop-validator.js'

// -----------------------------------------------------------------------
// Harness type — accumulated at the type level across provide() calls
// -----------------------------------------------------------------------

export type Harness<
  Ctx,
  State,
  Req extends keyof Ctx = never,
  Run extends keyof Ctx = never,
> = {
  provide<K extends keyof Ctx>(key: K, value: RequiredMarker): Harness<Ctx, State, Req | K, Run>
  provide<K extends keyof Ctx>(key: K, value: RuntimeMarker): Harness<Ctx, State, Req, Run | K>
  provide<K extends keyof Ctx>(key: K, value: DeepWithMarkers<Ctx[K]>): Harness<Ctx, State, Req, Run>

  // store() Req/Run are not affected at the type level; nested markers are runtime-validated only (F2 spike constraint)
  store(stores: DeepWithMarkers<{ session?: unknown } & Record<string, unknown>>): Harness<Ctx, State, Req, Run>

  // loop() parameter is LoopBuilder<State, Ctx> after F4 implementation
  loop(builder: (l: LoopBuilder<State, Ctx>) => void): Harness<Ctx, State, Req, Run>
}

// -----------------------------------------------------------------------
// ProviderEntry — one entry produced by each provide() or store() call
// -----------------------------------------------------------------------

export interface ProviderEntry {
  readonly kind: 'provide' | 'store'
  readonly key: string
  readonly value: unknown
}

// -----------------------------------------------------------------------
// HarnessInternals — the structural contract between HarnessBuilder and createAgent (F5)
// -----------------------------------------------------------------------

// _req, _run, _state are type witnesses: never assigned at runtime, carry type-level info to F5
export interface HarnessInternals<
  Ctx,
  State,
  Req extends keyof Ctx,
  Run extends keyof Ctx,
> {
  readonly stateSchema: Record<string, FieldDefinition<unknown>> | undefined
  readonly providers: readonly ProviderEntry[]
  readonly loopDef: LoopDefinition | undefined
  readonly _req: Req | undefined
  readonly _run: Run | undefined
  readonly _state: State | undefined
}

// -----------------------------------------------------------------------
// Internal accessor — used by createAgent (F5) to unwrap internals
// -----------------------------------------------------------------------

// symbol key is module-private; external code cannot read or forge the internals slot
const _internals = Symbol('_internals')

export type HarnessWithInternals<
  Ctx,
  State,
  Req extends keyof Ctx,
  Run extends keyof Ctx,
> = Harness<Ctx, State, Req, Run> & {
  readonly [_internals]: HarnessInternals<Ctx, State, Req, Run>
}

export function getInternals<
  Ctx,
  State,
  Req extends keyof Ctx,
  Run extends keyof Ctx,
>(harness: Harness<Ctx, State, Req, Run>): HarnessInternals<Ctx, State, Req, Run> {
  if (harness === null || typeof harness !== 'object' || !(_internals in harness)) {
    throw new HarnessInternalsError()
  }
  return (harness as HarnessWithInternals<Ctx, State, Req, Run>)[_internals] // as: `_internals in harness` check above guarantees the symbol key is present
}

// -----------------------------------------------------------------------
// Error class
// -----------------------------------------------------------------------

export class HarnessInternalsError extends Error {
  constructor() {
    super('value is not a HarnessBuilder instance — was it created by createHarness?')
    this.name = 'HarnessInternalsError'
  }
}

// -----------------------------------------------------------------------
// createHarness — the public factory
// -----------------------------------------------------------------------

export function createHarness<Ctx = any>(): <S extends object = {}>( // any: allows createHarness() without an explicit Ctx type parameter
  stateSchema?: S,
) => Harness<Ctx, StateFromSchema<S>> {
  return <S extends object = {}>(stateSchema?: S): Harness<Ctx, StateFromSchema<S>> => {
    const internals: HarnessInternals<Ctx, StateFromSchema<S>, never, never> = {
      stateSchema: stateSchema as Record<string, FieldDefinition<unknown>> | undefined, // as: S extends object; cast to internal schema representation
      providers: Object.freeze([]),
      loopDef: undefined,
      _req: undefined,
      _run: undefined,
      _state: undefined,
    }

    return createBuilderInstance(internals)
  }
}

function createBuilderInstance<
  Ctx,
  State,
  Req extends keyof Ctx = never,
  Run extends keyof Ctx = never,
>(internals: HarnessInternals<Ctx, State, Req, Run>): HarnessWithInternals<Ctx, State, Req, Run> {
  const builder: any = { // any: TypeScript cannot infer overloaded call signatures from object literal method definitions
    provide<K extends keyof Ctx>(
      key: K,
      value: RequiredMarker | RuntimeMarker | DeepWithMarkers<Ctx[K]>,
    ): Harness<Ctx, State, any, any> { // any: Req/Run accumulation is tracked at the type level via overloads; method body uses any to avoid inference conflicts
      const newProviders = Object.freeze([
        ...internals.providers,
        { kind: 'provide' as const, key: String(key), value },
      ])
      const newInternals: HarnessInternals<Ctx, State, any, any> = { // any: same reason as return type annotation above
        stateSchema: internals.stateSchema,
        providers: newProviders,
        loopDef: internals.loopDef,
        _req: undefined,
        _run: undefined,
        _state: undefined,
      }
      return createBuilderInstance(newInternals)
    },

    store(stores: DeepWithMarkers<{ session?: unknown } & Record<string, unknown>>): Harness<Ctx, State, Req, Run> {
      const newProviders = Object.freeze([
        ...internals.providers,
        { kind: 'store' as const, key: '__store__', value: stores },
      ])
      const newInternals: HarnessInternals<Ctx, State, Req, Run> = {
        stateSchema: internals.stateSchema,
        providers: newProviders,
        loopDef: internals.loopDef,
        _req: undefined,
        _run: undefined,
        _state: undefined,
      }
      return createBuilderInstance(newInternals)
    },

    loop(builderFn: (l: LoopBuilder<State, Ctx>) => void): Harness<Ctx, State, Req, Run> {
      const lb = createLoopBuilder<State, Ctx>()
      builderFn(lb)
      const def = extractLoopDefinition(lb as LoopBuilder<unknown, unknown>) // as: generic S/Ctx erased for internal storage
      validateLoop(def)
      const newInternals: HarnessInternals<Ctx, State, Req, Run> = {
        stateSchema: internals.stateSchema,
        providers: internals.providers,
        loopDef: def,
        _req: undefined,
        _run: undefined,
        _state: undefined,
      }
      return createBuilderInstance(newInternals)
    },

    [_internals]: internals,
  }

  return builder
}
