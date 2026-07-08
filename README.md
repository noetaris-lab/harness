# @noetaris/harness

Agent execution framework — the harness implementation.

```
agent = llm + harness
```

The harness is the reusable artifact: execution loop, state management, routing, and provider abstraction. The LLM is a swappable commodity component.

## Installation

```sh
pnpm add @noetaris/harness
```

Requires Node.js ≥ 22.

## Quick Start

```ts
import { createHarness, createAgent, field, required, runtime } from '@noetaris/harness'

// 1. Define the dependency interface your steps will need
interface Ctx {
  model: { invoke(messages: string[], opts: any): Promise<{ text: string; toolCalls: any[] }> }
  tools: Record<string, any>
  prompts: { system: string }
}

// 2. Create the harness — fixes Ctx and infers State from the field schema
const h = createHarness<Ctx>()({
  messages:  field<string[]>({ default: () => [],  reduce: (a, b) => [...a, ...b] }),
  toolCalls: field<any[]>   ({ default: () => [] }),
})

// 3. Define the loop — validated immediately at call time
h.loop(l =>
  l.start()
   .step('think', {
     run: async (state, ctx) => {
       const result = await ctx.model.invoke(state.messages, {
         tools: Object.values(ctx.tools),
       })
       return { messages: [result.text], toolCalls: result.toolCalls }
     },
     route: (state) => state.toolCalls.length > 0 ? 'call_tools' : 'complete',
   })
   .on('call_tools').to('action')
   .on('complete').end()
   .step('action', {
     run: async (state, ctx) => ({
       toolResults: await runTools(state.toolCalls, ctx.tools),
     }),
   })
   .next('think')
)

// 4. Declare providers
h.provide('tools',   { search: new MySearchTool() }) // hard-coded
h.provide('prompts', required())                     // must be supplied at createAgent()
h.provide('model',   runtime())                      // must be supplied at agent.run()

// 5. Create an agent — assigns an ID and fills required() slots
const agent = createAgent('my-agent', h, {
  prompts: { system: 'You are a helpful assistant.' },
})

// 6. Run
const run = agent.run(
  { messages: ['What is the weather in Paris?'] },
  { model: new MyLLMAdapter() },
)

const outcome = await run
console.log(outcome.signal, outcome.state)
```

## Concepts

### The Loop

A harness loop is a directed graph. Steps are nodes; transitions are edges.

- **`run`** — transforms state. The only place state changes.
- **`route`** — reads post-run state, emits a named signal. Pure — no `ctx`, no mutation.

Three step patterns:

| Pattern | `run` | `route` | Transition |
|---|---|---|---|
| Transform + route | ✅ | ✅ | `.on(signal).to(step)` |
| Transform + next  | ✅ | ❌ | `.next(name)` or implicit |
| Decision node     | ❌ | ✅ | `.on(signal).to(step)` |

The loop structure is **validated at `h.loop()` call time**. Violations are thrown together as a `LoopValidationError` with a `violations: readonly string[]` property.

### State

State is defined as a schema of `field<T>()` declarations. The framework infers the `State` type — no separate interface needed.

```ts
const h = createHarness<Ctx>()({
  messages: field<string[]>({
    default: () => [],
    reduce:  (accumulated, update) => [...accumulated, ...update],
  }),
  count: field<number>({ default: () => 0 }),
})
// State = { messages: string[], count: number }
```

Steps return a `Partial<State>` update. The `reduce` function merges accumulating fields; absent fields are replaced directly.

### Providers

`h.provide()` is the single extension point — everything on `ctx` comes through it.

```ts
h.provide('tools',   { search: myTool })  // hard-coded — shared by all agents
h.provide('prompts', required())          // build-time — supplied at createAgent()
h.provide('model',   runtime())           // per-run   — supplied at agent.run()
```

### Session Store

`h.store()` adds persistence. The reserved `session` key is used by the framework to save and restore state across runs.

```ts
import { InMemorySessionStore } from '@noetaris/harness-store'

h.store({
  session: new InMemorySessionStore(), // framework-managed lifecycle
})
```

> **Note:** Only the `session` key is processed today. Surfacing additional
> store keys to steps as `ctx.store.<name>` is planned but not yet wired up —
> non-session keys passed to `h.store()` are currently ignored.

The framework injects `ctx.sessionId` automatically on every run — no declaration in `Ctx` needed.

### Interrupts

A run can be stopped or resumed:

```ts
const run = agent.run(initialState, slots)
run.stop()                 // request graceful stop at the next step boundary

// When a step calls ctx.interrupt(), the run settles with signal "$interrupt".
// Resume in the same process:
const resumed = run.resume(response, interruptId)

// Or cross-process (requires a session store):
const resumed = agent.resume(response, sessionId, interruptId)
```

## API

| Export | Description |
|---|---|
| `createHarness<Ctx>()(schema)` | Creates a harness. Fixes `Ctx`, infers `State` from schema. |
| `createAgent(id, h, slots)` | Assigns the agent an ID and fills `required()` slots. Returns an `Agent`. |
| `field<T>(opts)` | Declares a state field with a default and optional reduce function. |
| `required()` | Marks a provider slot as required at `createAgent()`. |
| `runtime()` | Marks a provider slot as required at `agent.run()`. |
| `composeObservers(...observers)` | Merges multiple `Observer` instances into one fan-out observer. |
| `SessionStore` | Interface for session persistence backends. |
| `StoredRun` | Type for a persisted run snapshot. Includes `agentId`, `runId`, `sessionId`, `phase`, and state. |
| `Observer` | Interface for telemetry hooks on run and step lifecycle events. |
| `ObserverAware` | Interface for provider objects that accept an `Observer` binding via `bindObserver()`. |
| `RunContext` | Context passed to run-level observer hooks — `agentId`, `sessionId`. |
| `StepContext` | Context passed to step-level observer hooks — `agentId`, `sessionId`, `stepName`. |
| `NoInterruptError` | Thrown when `resume()` is called but the session is not paused on a matching interrupt. |
| `SessionInFlightError` | Thrown when a session is already running. |
| `SessionPendingInterruptError` | Thrown when a session is paused on a pending interrupt — use `agent.resume()` instead of `agent.run()`. |
| `StoreLoadError` | Thrown when the session store fails to load state. |

## Design Principles

- **The loop is a contract, not optional.** Every agent is a loop with defined entry, routing, and exit. Structure is validated at definition time.
- **State is the only spine.** Steps do not call each other — they write to state; the loop routes based on state.
- **The framework owns what is universal.** Loop lifecycle, state management, session store lifecycle. Never prompt content, tool behaviour, or provider APIs.
- **Built-ins are sugar, not magic.** `h.store()` is `h.provide()` plus lifecycle hooks — no hidden mechanism.

## Requirements

- Node.js ≥ 22
- ESM only (`"type": "module"`)
- Zero runtime dependencies

## Related Packages

- [`@noetaris/harness-store`](https://github.com/noetaris-lab/harness-store) — session store implementations (`InMemorySessionStore`, `LocalFileSessionStore`, etc.)
- [`@noetaris/harness-types`](https://github.com/noetaris-lab/harness-types) — shared LLM type contract (`LLM`, `Message`, `Tool`, `ToolCall`, `LLMResponse`)
- [`@noetaris/harness-anthropic`](https://github.com/noetaris-lab/harness-anthropic) — Anthropic Claude adapter
- [`@noetaris/harness-openai`](https://github.com/noetaris-lab/harness-openai) — OpenAI adapter
- [`@noetaris/harness-google`](https://github.com/noetaris-lab/harness-google) — Google Gemini adapter
- [`@noetaris/harness-otel`](https://github.com/noetaris-lab/harness-otel) — OpenTelemetry observer bridge

## License

MIT
