/**
 * `@noetaris/harness` — execution loop, state management, routing, and provider abstraction
 * for building LLM agents.
 *
 * **Quick start:**
 * ```ts
 * import { createHarness, createAgent, field } from '@noetaris/harness'
 *
 * const h = createHarness<{ llm: LLM }>()()
 *   .provide('llm', required())
 *   .loop(l => {
 *     l.start().step('run', { run, route }).on('done').end()
 *   })
 *
 * const agent = createAgent('my-agent', h, { llm })
 * const { state } = await agent.run({}, {})
 * ```
 *
 * @packageDocumentation
 */
export { field, type FieldDefinition, type StateFromSchema } from './harness/state-field.js'
export {
  required,
  runtime,
  isRequiredMarker,
  isRuntimeMarker,
  REQUIRED_TAG,
  RUNTIME_TAG,
  type RequiredMarker,
  type RuntimeMarker,
  type DeepWithMarkers,
} from './harness/ctx-markers.js'
export { createHarness, type Harness, LoopNotDefinedError } from './harness/harness-builder.js'
export {
  createAgent,
  type Agent,
} from './agent/create-agent.js'
export { type SessionStore, type StoredRun, type ClaimOptions, type Lease, type StoredRunMetadata } from './agent/session-store.js'
export { NoInterruptError } from './agent/interrupt-resume.js'
export { SessionInFlightError, SessionPendingInterruptError, StoreLoadError, SessionBusyError, LeaseExpiredError } from './agent/concurrency-errors.js'
export {
  composeObservers,
  type RunContext,
  type StepContext,
  type Observer,
  type ObserverAware,
} from './agent/observer.js'

export {
  type LoopDefinition,
  type StepDef,
  type SignalTransition,
  type TransitionTarget,
  type FrameworkState,
  type StepState,
  type RunFn,
  type RouteFn,
} from './loop/loop-dsl.js'
