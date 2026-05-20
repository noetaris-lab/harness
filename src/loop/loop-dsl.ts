// -----------------------------------------------------------------------
// Framework-reserved state fields — readable in run/route, not writable from run return
// -----------------------------------------------------------------------

/**
 * Framework-managed fields injected into every step function's `state` argument.
 *
 * - `$error` — the `Error` thrown by the previous step, or `null` if no error occurred.
 *   Only populated on the error path; non-error-aware steps never see a non-null value here.
 * - `$interrupt` — set while a step is awaiting a resume response.  The `response` field
 *   is populated after {@link Agent.resume} is called.
 */
export interface FrameworkState {
  readonly $error: Error | null
  readonly $interrupt: {
    readonly interruptId: string
    readonly prompt: unknown
    readonly response?: unknown
  } | null
}

/**
 * The complete state type visible inside {@link RunFn} step functions:
 * the user-defined state `S` merged with {@link FrameworkState}.
 */
export type StepState<S> = S & FrameworkState

// -----------------------------------------------------------------------
// Step function signatures
// -----------------------------------------------------------------------

/**
 * State transformer. Receives the full step state and ctx; returns a partial update
 * of user-defined state fields only (framework-reserved fields are excluded from return).
 * May be async.
 */
export type RunFn<S, Ctx> = (
  state: StepState<S>,
  ctx: Ctx & {
    readonly agentId: string
    readonly sessionId: string
    readonly interrupt: (prompt: unknown, id?: string) => Promise<unknown>
    readonly emit: (name: string, payload?: unknown) => void
  },
) => Promise<Partial<Omit<S, '$error' | '$interrupt'>>> | Partial<Omit<S, '$error' | '$interrupt'>>

/**
 * Pure signal emitter. Receives step state without $error — the route is not called on the error
 * path unless the step opts in via `optin: '$error'` in the step config. Synchronous by design.
 * No ctx — pure read only.
 */
export type RouteFn<S> = (state: S & Omit<FrameworkState, '$error'>) => string

/**
 * Pure signal emitter for error-aware steps (optin: '$error').
 * Receives the full step state including $error — the executor calls this on both the success
 * and error paths. Declare `optin: '$error'` in the step config to use this variant.
 */
export type ErrorAwareRouteFn<S> = (state: StepState<S>) => string

/**
 * Options passed to `.step(name, options)`. At least one of `run` or `route` must be set.
 *
 * Two variants:
 * - Without `optin`: route receives state without `$error` (TypeScript-enforced). On error,
 *   the framework falls through to `l.onError()` or pauses with `signal: "$error"` automatically.
 * - With `optin: '$error'`: route receives the full state including `$error`, and the executor
 *   calls route on the error path. Use this when the step's route needs to inspect or handle errors.
 */
export type StepOptions<S, Ctx> =
  | {
      readonly optin: '$error'
      run?: RunFn<S, Ctx>
      route?: ErrorAwareRouteFn<S>
    }
  | {
      readonly optin?: undefined
      run?: RunFn<S, Ctx>
      route?: RouteFn<S>
    }

// -----------------------------------------------------------------------
// LoopDefinition — the captured topology produced by the builder
// -----------------------------------------------------------------------

/**
 * Where a signal transition routes to.
 * 'step' — routes to the named step.
 * 'end'  — exits the loop; run resolves with the emitted signal.
 */
export type TransitionTarget =
  | { readonly kind: 'step'; readonly name: string }
  | { readonly kind: 'end' }

/** A single `.on(signal).to(step)` or `.on(signal).end()` declaration. */
export interface SignalTransition {
  readonly signal: string
  readonly target: TransitionTarget
}

/**
 * Compiled step definition stored in LoopDefinition.
 * run and route are stored as-is (user functions — validated structurally, not semantically).
 * transitions: all .on() declarations attached to this step.
 * next: explicit .next(name) target, or undefined if none declared.
 * errorAware: true when the step was declared with optin: '$error' — the executor calls route
 *   on the error path when this is true.
 */
export interface StepDef {
  readonly name: string
  readonly run: RunFn<unknown, unknown> | undefined
  readonly route: RouteFn<unknown> | undefined
  readonly transitions: readonly SignalTransition[]
  readonly next: string | undefined
  readonly errorAware: boolean
}

/**
 * Complete loop topology captured from the builder lambda.
 * Immutable snapshot — produced once, consumed by LoopValidator and (later) F6.
 *
 * startCalled: true if l.start() was invoked at least once.
 * entryStep: name of the first .step() declared after .start() was called; undefined if .start()
 *   was never called or no step was declared after it.
 * steps: all declared steps in declaration order.
 * onError: the fallback step name from l.onError(), or undefined if not set.
 */
export interface LoopDefinition {
  readonly startCalled: boolean
  readonly entryStep: string | undefined
  readonly steps: readonly StepDef[]
  readonly onError: string | undefined
}

// -----------------------------------------------------------------------
// LoopBuilder — the DSL object passed to the h.loop() builder lambda
// -----------------------------------------------------------------------

/**
 * Fluent chain returned by .on(signal). Caller must call either .to(step) or .end()
 * to complete the transition declaration.
 */
export interface OnChain<S, Ctx> {
  /** Route the signal to the named step. Returns the builder for further chaining. */
  to(step: string): LoopBuilder<S, Ctx>
  /** Exit the loop when this signal is emitted. Returns the builder for further chaining. */
  end(): LoopBuilder<S, Ctx>
}

/**
 * The DSL object passed as `l` to the h.loop(l => ...) builder lambda.
 * All methods mutate internal state and return `this` for chaining.
 */
export interface LoopBuilder<S, Ctx> {
  /** Mark the loop as having a declared entry. The first .step() called after .start() is the entry. */
  start(): LoopBuilder<S, Ctx>
  /** Declare a step. At least one of run or route must be set (validated later by LoopValidator). */
  step(name: string, options: StepOptions<S, Ctx>): LoopBuilder<S, Ctx>
  /**
   * Begin a signal transition declaration. Must be called immediately after .step() or after
   * a previous .on().to() or .on().end() chain (attaches to the most recently declared step).
   */
  on(signal: string): OnChain<S, Ctx>
  /**
   * Declare an explicit unconditional next target for the most recently declared step.
   * Mutually exclusive with route (validated by LoopValidator).
   */
  next(name: string): LoopBuilder<S, Ctx>
  /**
   * Declare a loop-level fallback error step. Any step whose run throws and whose
   * route does not handle $error will route to this step instead of pausing the session.
   * Only one onError target per loop; multiple calls replace the previous target (last wins).
   */
  onError(step: string): LoopBuilder<S, Ctx>
}

// -----------------------------------------------------------------------
// Error class
// -----------------------------------------------------------------------

/** Thrown by extractLoopDefinition when the argument is not a createLoopBuilder() instance. */
export class InvalidLoopBuilderError extends Error {
  constructor() {
    super('argument is not a LoopBuilder instance — was it created by createLoopBuilder?')
    this.name = 'InvalidLoopBuilderError'
  }
}

// -----------------------------------------------------------------------
// Internal implementation
// -----------------------------------------------------------------------

// Module-private symbol for internal state
const _builderState = Symbol('builderState')

// Internal mutable step definition during collection
interface StepDefMutable {
  name: string
  run: RunFn<unknown, unknown> | undefined
  route: RouteFn<unknown> | undefined
  transitions: SignalTransition[]
  next: string | undefined
  errorAware: boolean
}

// Internal mutable builder state
interface BuilderState {
  startCalled: boolean
  entryStep: string | undefined
  steps: StepDefMutable[]
  onError: string | undefined
}

// Deep freeze utility
function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj)

  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value)
    }
  }

  return obj
}

/**
 * Create a new LoopBuilder instance for use in a h.loop() lambda.
 * The returned object accumulates all DSL calls in mutable internal state.
 */
export function createLoopBuilder<S, Ctx>(): LoopBuilder<S, Ctx> {
  const state: BuilderState = {
    startCalled: false,
    entryStep: undefined,
    steps: [],
    onError: undefined,
  }

  const builder: any = {
    start(this: any): LoopBuilder<S, Ctx> {
      state.startCalled = true
      return this
    },

    step(this: any, name: string, options: StepOptions<S, Ctx>): LoopBuilder<S, Ctx> {
      const stepDef: StepDefMutable = {
        name,
        run: options.run as RunFn<unknown, unknown> | undefined, // as: contravariance in state parameter
        route: options.route as RouteFn<unknown> | undefined, // as: contravariance in state parameter
        transitions: [],
        next: undefined,
        errorAware: options.optin === '$error',
      }
      state.steps.push(stepDef)

      // Set entryStep to the first step after start() was called
      if (state.startCalled && state.entryStep === undefined) {
        state.entryStep = name
      }

      return this
    },

    on(this: any, signal: string): OnChain<S, Ctx> {
      // Guard: if no step has been declared yet, return no-op OnChain
      if (state.steps.length === 0) {
        return {
          to: () => this,
          end: () => this,
        }
      }

      const currentStep = state.steps.at(-1)

      return {
        to: (step: string): LoopBuilder<S, Ctx> => {
          currentStep?.transitions.push({
            signal,
            target: { kind: 'step', name: step },
          })
          return this
        },
        end: (): LoopBuilder<S, Ctx> => {
          currentStep?.transitions.push({
            signal,
            target: { kind: 'end' },
          })
          return this
        },
      }
    },

    next(this: any, name: string): LoopBuilder<S, Ctx> {
      // Guard: if no step has been declared yet, this is a no-op
      if (state.steps.length > 0) {
        const currentStep = state.steps.at(-1)
        if (currentStep !== undefined) {
          currentStep.next = name
        }
      }
      return this
    },

    onError(this: any, step: string): LoopBuilder<S, Ctx> {
      state.onError = step
      return this
    },
  }

  // Attach the internal state symbol
  ;(builder as any)[_builderState] = state

  return builder as LoopBuilder<S, Ctx>
}

/**
 * Extract the LoopDefinition accumulated by a builder created with createLoopBuilder().
 * Called by harness-builder.ts immediately after the user's builder lambda returns.
 * Throws InvalidLoopBuilderError if the argument was not produced by createLoopBuilder().
 */
export function extractLoopDefinition(builder: LoopBuilder<unknown, unknown>): LoopDefinition {
  // Identity check: ensure builder has the internal state symbol
  if (builder === null || builder === undefined || !(_builderState in builder)) {
    throw new InvalidLoopBuilderError()
  }

  const state = (builder as any)[_builderState] as BuilderState

  // Convert mutable step definitions to immutable ones
  const immutableSteps: StepDef[] = state.steps.map((step) => {
    const transitions = Object.freeze([...step.transitions]) as readonly SignalTransition[]
    // Freeze each transition
    for (const transition of transitions) {
      Object.freeze(transition)
      Object.freeze(transition.target)
    }
    const stepDef: StepDef = {
      name: step.name,
      run: step.run,
      route: step.route,
      transitions,
      next: step.next,
      errorAware: step.errorAware,
    }
    return Object.freeze(stepDef)
  })

  // Create the frozen LoopDefinition
  const definition: LoopDefinition = {
    startCalled: state.startCalled,
    entryStep: state.entryStep,
    steps: Object.freeze(immutableSteps),
    onError: state.onError,
  }

  // Deep freeze the entire structure
  return deepFreeze(definition)
}
