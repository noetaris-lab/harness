import type { ObserverAware, Observer, StepContext } from './observer.js'

// Item 1 & 3: bindObserver-only object satisfies ObserverAware
const bindOnly: ObserverAware = {
  bindObserver(_observer: Observer) {},
}

// Item 2: both methods declared as methods
const withBoth: ObserverAware = {
  bindObserver(_observer: Observer) {},
  setStepContext(_ctx: StepContext) {},
}

// Item 4: setStepContext as arrow function
const withArrow: ObserverAware = {
  bindObserver(_observer: Observer) {},
  setStepContext: (_ctx: StepContext) => {},
}

// Suppresses "declared but never read" errors without importing the values into a test
void bindOnly; void withBoth; void withArrow
