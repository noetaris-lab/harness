import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LoopBuilder, LoopDefinition } from './loop-dsl.js'
import { createLoopBuilder, extractLoopDefinition } from './loop-dsl.js'
import { validateLoop, LoopValidationError } from './loop-validator.js'
import { createHarness, getInternals } from '../harness/harness-builder.js'

// Test helper: create a LoopDefinition from a builder lambda
function build(fn: (l: LoopBuilder<any, any>) => void): LoopDefinition {
  const lb = createLoopBuilder<any, any>()
  fn(lb)
  return extractLoopDefinition(lb as LoopBuilder<unknown, unknown>)
}

describe('validateLoop', () => {
  describe('valid loops', () => {
    it('returns void for a single-step loop with run, route, and one exit', () => {
      const f = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f, route: () => 'done' })
          .on('done')
          .end(),
      )

      expect(() => validateLoop(def)).not.toThrow()
    })

    it('returns void for a two-step loop with explicit .next()', () => {
      const f = vi.fn()
      const r = () => 'done'
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .next('b')
          .step('b', { route: r })
          .on('done')
          .end(),
      )

      expect(() => validateLoop(def)).not.toThrow()
    })

    it('returns void for a loop with onError pointing to a declared step', () => {
      const f = vi.fn()
      const g = vi.fn()
      const h = vi.fn()
      const rB = () => 'done'
      const rErr = () => 'retry'
      const def = build((l) =>
        l
          .onError('err')
          .start()
          .step('a', { run: f })
          .step('b', { run: g, route: rB })
          .on('done')
          .end()
          .step('err', { run: h, route: rErr })
          .on('retry')
          .to('a')
          .on('bail')
          .end(),
      )

      expect(() => validateLoop(def)).not.toThrow()
    })

    it('returns void for a loop with a backward .next() (loop-back to earlier step)', () => {
      const f = vi.fn()
      const r = () => 'go'
      const def = build((l) =>
        l
          .start()
          .step('a', { route: r })
          .on('go')
          .to('b')
          .on('done')
          .end()
          .step('b', { run: f })
          .next('a'),
      )

      expect(() => validateLoop(def)).not.toThrow()
    })

    it('returns void for a three-step loop where middle step has implicit next', () => {
      const f = vi.fn()
      const g = vi.fn()
      const r = () => 'done'
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .step('b', { run: g })
          .step('c', { route: r })
          .on('done')
          .end(),
      )

      expect(() => validateLoop(def)).not.toThrow()
    })
  })

  describe('Rule 1 — step missing run and route', () => {
    it('throws LoopValidationError when step has neither run nor route', () => {
      const def = build((l) =>
        l
          .start()
          .step('empty', {}),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.length).toBeGreaterThanOrEqual(1)
        expect(e.violations.some((v) => v.includes('"empty"') && v.includes('run or route'))).toBe(true)
      }
    })
  })

  describe('Rule 2 — route with no .on() transitions', () => {
    it('throws LoopValidationError when step has route but no .on() declarations', () => {
      const r = () => 'done'
      const def = build((l) =>
        l
          .start()
          .step('think', { route: r }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"think"') && v.includes('.on()'))).toBe(true)
      }
    })
  })

  describe('Rule 3 — last step with no exit path', () => {
    it('throws LoopValidationError for last step and does not flag non-last step', () => {
      const f = vi.fn()
      const g = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .step('b', { run: g }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"b"') && v.includes('no exit path'))).toBe(true)
        expect(e.violations.every((v) => !(v.includes('"a"') && v.includes('no exit path')))).toBe(true)
      }
    })
  })

  describe('Rule 4 — route and .next() mutually exclusive', () => {
    it('throws LoopValidationError when step has both route and .next()', () => {
      const f = vi.fn()
      const r = () => 'x'
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f, route: r })
          .on('x')
          .end()
          .next('b')
          .step('b', { run: f }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"a"') && v.includes('mutually exclusive'))).toBe(true)
      }
    })
  })

  describe('Rule 5 — duplicate step names', () => {
    it('throws LoopValidationError for two steps with the same name', () => {
      const f = vi.fn()
      const g = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('think', { run: f })
          .step('think', { run: g }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('duplicate') && v.includes('"think"'))).toBe(true)
      }
    })

    it('reports exactly one duplicate violation when a name appears three times', () => {
      const f = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .step('b', { run: f })
          .step('a', { run: f }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.filter((v) => v.includes('"a"') && v.includes('duplicate')).length).toBe(1)
      }
    })
  })

  describe('Rule 6 — unknown transition targets', () => {
    it('throws LoopValidationError when .to() names an undeclared step', () => {
      const r = () => 'go'
      const def = build((l) =>
        l
          .start()
          .step('a', { route: r })
          .on('go')
          .to('nonexistent'),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"nonexistent"') && v.includes('not declared'))).toBe(true)
      }
    })

    it('throws LoopValidationError when onError names an undeclared step', () => {
      const r = () => 'done'
      const def = build((l) =>
        l
          .onError('ghost')
          .start()
          .step('a', { run: vi.fn(), route: r })
          .on('done')
          .end(),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(
          e.violations.some((v) => v.includes('onError') && v.includes('"ghost"') && v.includes('not a declared')),
        ).toBe(true)
      }
    })

    it('throws LoopValidationError when .next() names an undeclared step', () => {
      const f = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .next('ghost'),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"a"') && v.includes('"ghost"') && v.includes('not declared'))).toBe(true)
      }
    })
  })

  describe('Rule 7 — missing .start() or .end()', () => {
    it('throws LoopValidationError when .start() was never called', () => {
      const f = vi.fn()
      const r = () => 'done'
      const def = build((l) =>
        l
          .step('a', { run: f, route: r })
          .on('done')
          .end(),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('.start()') && (v.includes('missing') || v.includes('call')))).toBe(true)
      }
    })

    it('throws LoopValidationError when .start() is called but no step declared after it', () => {
      const def = build((l) => l.start())

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('.start()') && v.includes('no step'))).toBe(true)
      }
    })

    it('throws LoopValidationError when no .on().end() exit is declared', () => {
      const f = vi.fn()
      const g = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .step('b', { run: g }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(
          e.violations.some((v) => v.includes('no exit') || (v.includes('.end()') && v.includes('loop'))),
        ).toBe(true)
      }
    })
  })

  describe('Rule 8 — unreachable steps', () => {
    it('throws LoopValidationError for a step unreachable from the entry step', () => {
      const r = () => 'x'
      const f = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { route: r })
          .on('x')
          .end()
          .step('orphan', { run: f }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"orphan"') && v.includes('unreachable'))).toBe(true)
      }
    })

    it('does not flag onError target as unreachable when it is the only path to the step', () => {
      const f = vi.fn()
      const h = vi.fn()
      const rErr = () => 'bail'
      const def = build((l) =>
        l
          .onError('err')
          .start()
          .step('a', { run: f, route: () => 'ok' })
          .on('ok')
          .end()
          .step('err', { run: h, route: rErr })
          .on('bail')
          .end(),
      )

      expect(() => validateLoop(def)).not.toThrow()
    })

    it('throws LoopValidationError for a step declared after a routed entry that never targets it', () => {
      const f = vi.fn()
      const g = vi.fn()
      const h = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .next('b')
          .step('b', { run: g, route: () => 'done' })
          .on('done')
          .end()
          .step('c', { run: h }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.some((v) => v.includes('"c"') && v.includes('unreachable'))).toBe(true)
      }
    })
  })

  describe('Rule 9 — .on() transitions without route', () => {
    it('throws LoopValidationError when step has .on() transitions but no route', () => {
      const f = vi.fn()
      const def = build((l) =>
        l
          .start()
          .step('a', { run: f })
          .on('foo')
          .to('b')
          .step('b', { run: vi.fn(), route: () => 'done' })
          .on('done')
          .end(),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(
          e.violations.some((v) => v.includes('"a"') && v.includes('.on()') && v.includes('no route')),
        ).toBe(true)
      }
    })
  })

  describe('Multi-violation collection', () => {
    it('reports violations from two simultaneous rule failures', () => {
      const f = vi.fn()
      const def = build((l) =>
        l
          .step('think', { run: f })
          .step('think', { run: f }),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.length).toBeGreaterThanOrEqual(2)
        expect(e.violations.some((v) => v.includes('.start()'))).toBe(true)
        expect(e.violations.some((v) => v.includes('duplicate') && v.includes('"think"'))).toBe(true)
        expect(e.message).toContain('-')
      }
    })

    it('collects three violations from a compound invalid loop', () => {
      const r = () => 'x'
      const def = build((l) =>
        l
          .step('a', { route: r })
          .on('x')
          .to('ghost'),
      )

      expect(() => validateLoop(def)).toThrow(LoopValidationError)

      try {
        validateLoop(def)
      } catch (err) {
        const e = err as LoopValidationError
        expect(e.violations.length).toBeGreaterThanOrEqual(3)
        expect(e.violations.some((v) => v.includes('.start()'))).toBe(true)
        expect(e.violations.some((v) => v.includes('no exit') || (v.includes('.end()')))).toBe(true)
        expect(e.violations.some((v) => v.includes('"ghost"') && v.includes('not declared'))).toBe(true)
      }
    })
  })
})

describe('harness-builder.ts integration', () => {
  it('stores LoopDefinition with correct entryStep after valid h.loop() call', () => {
    const h0 = createHarness()()
    const f = vi.fn()

    const h1 = h0.loop((l) =>
      l
        .start()
        .step('a', { run: f, route: () => 'done' })
        .on('done')
        .end(),
    )

    const internals = getInternals(h1)
    expect(internals.loopDef).toBeDefined()
    expect(internals.loopDef?.entryStep).toBe('a')
    expect(internals.loopDef?.steps).toHaveLength(1)
  })

  it('throws LoopValidationError immediately at h.loop() call time for an invalid loop', () => {
    const h0 = createHarness()()

    const call = () =>
      h0.loop((l) =>
        l
          .start()
          .step('empty', {}),
      )

    expect(call).toThrow(LoopValidationError)
    expect(getInternals(h0).loopDef).toBeUndefined()
  })

  it('loopDef reflects the second loop definition when h.loop() is called twice', () => {
    const h0 = createHarness()()
    const f = vi.fn()

    const h1 = h0.loop((l) =>
      l
        .start()
        .step('first', { run: f, route: () => 'done' })
        .on('done')
        .end(),
    )

    const h2 = h1.loop((l) =>
      l
        .start()
        .step('second', { run: f, route: () => 'done' })
        .on('done')
        .end(),
    )

    expect(getInternals(h2).loopDef?.entryStep).toBe('second')
    expect(getInternals(h1).loopDef?.entryStep).toBe('first')
  })

  it('loopDef is undefined on a harness that has never had loop() called', () => {
    const h = createHarness()()
    const internals = getInternals(h)
    expect(internals.loopDef).toBeUndefined()
  })
})
