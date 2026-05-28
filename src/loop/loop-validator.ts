import type { LoopDefinition } from './loop-dsl.js'

// -----------------------------------------------------------------------
// Error class
// -----------------------------------------------------------------------

/**
 * Thrown by validateLoop() when the LoopDefinition violates one or more structural rules.
 * violations: every rule violation found, as human-readable strings.
 * The full list is always reported — validateLoop() never fails fast on the first violation.
 */
export class LoopValidationError extends Error {
  readonly violations: readonly string[]

  constructor(violations: readonly string[]) {
    super(`loop validation failed:\n${violations.map((v) => `  - ${v}`).join('\n')}`)
    this.name = 'LoopValidationError'
    this.violations = violations
  }
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Validate a LoopDefinition against all structural rules.
 * Collects every violation before throwing, so developers see the full picture.
 *
 * @param def - a LoopDefinition produced by extractLoopDefinition()
 * @throws LoopValidationError if one or more validation rules are violated
 */
export function validateLoop(def: LoopDefinition): void {
  const violations: string[] = []

  // Build a set of all declared step names once — reuse for rules 6 and 8
  const names = new Set(def.steps.map((s) => s.name))

  // -----------------------------------------------------------------------
  // Rule 1 — Every step has at least `run` or `route`
  // -----------------------------------------------------------------------
  for (const step of def.steps) {
    if (step.run === undefined && step.route === undefined) {
      violations.push(`step "${step.name}" must have at least one of run or route`)
    }
  }

  // -----------------------------------------------------------------------
  // Rule 2 — A step with `route` must have at least one `.on()` transition
  // -----------------------------------------------------------------------
  for (const step of def.steps) {
    if (step.route !== undefined && step.transitions.length === 0) {
      violations.push(`step "${step.name}" has route but no .on() transitions — every signal must be handled`)
    }
  }

  // -----------------------------------------------------------------------
  // Rule 3 — A step without `route` must have a next target
  // -----------------------------------------------------------------------
  for (const [i, step] of def.steps.entries()) {
    if (step === undefined) continue
    if (step.route === undefined) {
      // Non-last steps have implicit next = the following step; they satisfy rule 3
      // Last step must have explicit next or be unreachable via rule 8
      const isLast = i === def.steps.length - 1
      if (isLast && step.next === undefined) {
        violations.push(
          `step "${step.name}" has no route, no explicit .next(), and no following step — no exit path`,
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rule 4 — A step cannot have both `route` and `.next()`
  // -----------------------------------------------------------------------
  for (const step of def.steps) {
    if (step.route !== undefined && step.next !== undefined) {
      violations.push(`step "${step.name}" has both route and .next() — these are mutually exclusive`)
    }
  }

  // -----------------------------------------------------------------------
  // Rule 5 — No duplicate step names
  // -----------------------------------------------------------------------
  const seen = new Set<string>()
  for (const step of def.steps) {
    if (seen.has(step.name)) {
      violations.push(`duplicate step name "${step.name}"`)
    }
    seen.add(step.name)
  }

  // -----------------------------------------------------------------------
  // Rule 6 — All `.to(name)` targets, `.next()` targets, and `onError` target
  // must reference a declared step
  // -----------------------------------------------------------------------
  for (const step of def.steps) {
    for (const transition of step.transitions) {
      if (transition.target.kind === 'step') {
        if (!names.has(transition.target.name)) {
          violations.push(
            `step "${step.name}" has .on("${transition.signal}").to("${transition.target.name}") but step "${transition.target.name}" is not declared`,
          )
        }
      }
    }

    if (step.next !== undefined) {
      if (!names.has(step.next)) {
        violations.push(
          `step "${step.name}" has .next("${step.next}") but step "${step.next}" is not declared`,
        )
      }
    }
  }

  if (def.onError !== undefined) {
    if (!names.has(def.onError)) {
      violations.push(`onError target "${def.onError}" is not a declared step`)
    }
  }

  // -----------------------------------------------------------------------
  // Rule 7 — The loop must have an entry (`.start()`) and at least one exit (`.end()`)
  // -----------------------------------------------------------------------
  if (def.startCalled === false) {
    violations.push(`loop is missing .start() — call l.start() before declaring steps`)
  }

  if (def.startCalled && def.entryStep === undefined) {
    violations.push(`l.start() was called but no step was declared after it — declare at least one step`)
  }

  // Check for at least one exit (.end())
  let hasExit = false
  for (const step of def.steps) {
    for (const transition of step.transitions) {
      if (transition.target.kind === 'end') {
        hasExit = true
        break
      }
    }
    if (hasExit) break
  }

  if (!hasExit) {
    violations.push(`loop has no exit — add at least one .on("<signal>").end()`)
  }

  // -----------------------------------------------------------------------
  // Rule 8 — No unreachable steps
  // -----------------------------------------------------------------------
  // Only checked if def.entryStep !== undefined (rule 7 covers missing entry)
  if (def.entryStep !== undefined) {
    // BFS from entryStep to find all reachable steps
    const reachable = new Set<string>([def.entryStep])
    const queue: string[] = [def.entryStep]

    // Also mark onError target as reachable upfront
    if (def.onError !== undefined) {
      reachable.add(def.onError)
      if (!queue.includes(def.onError)) {
        queue.push(def.onError)
      }
    }

    while (queue.length > 0) {
      const currentName = queue.shift()!
      const currentStep = def.steps.find((s) => s.name === currentName)

      if (!currentStep) continue

      // Add all steps reachable via signal transitions
      for (const transition of currentStep.transitions) {
        if (transition.target.kind === 'step') {
          if (!reachable.has(transition.target.name)) {
            reachable.add(transition.target.name)
            queue.push(transition.target.name)
          }
        }
      }

      // Add next target if explicit or implicit
      if (currentStep.route !== undefined) {
        // Step has route, so no implicit next
        if (currentStep.next !== undefined && !reachable.has(currentStep.next)) {
          reachable.add(currentStep.next)
          queue.push(currentStep.next)
        }
      } else {
        // Step has no route: follow explicit next or implicit next
        if (currentStep.next !== undefined) {
          if (!reachable.has(currentStep.next)) {
            reachable.add(currentStep.next)
            queue.push(currentStep.next)
          }
        } else {
          // Implicit next: the following step in def.steps, if any
          const currentIndex = def.steps.findIndex((s) => s.name === currentName)
          if (currentIndex !== -1 && currentIndex < def.steps.length - 1) {
            const nextStep = def.steps[currentIndex + 1]
            if (nextStep !== undefined) {
              const nextStepName = nextStep.name
              if (!reachable.has(nextStepName)) {
                reachable.add(nextStepName)
                queue.push(nextStepName)
              }
            }
          }
        }
      }
    }

    // Check for unreachable steps
    for (const step of def.steps) {
      if (!reachable.has(step.name)) {
        violations.push(`step "${step.name}" is unreachable from the entry step "${def.entryStep}"`)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rule 9 (derived) — A step without `route` must not declare `.on()` signal transitions
  // -----------------------------------------------------------------------
  for (const step of def.steps) {
    if (step.route === undefined && step.transitions.length > 0) {
      violations.push(
        `step "${step.name}" has .on() transitions but no route — .on() is only valid when route is set`,
      )
    }
  }

  // -----------------------------------------------------------------------
  // Throw if any violations found
  // -----------------------------------------------------------------------
  if (violations.length > 0) {
    throw new LoopValidationError(violations)
  }
}
