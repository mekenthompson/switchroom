import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Regression guard for the fail-closed contract on the secret-detect
 * pipeline in server.ts.
 *
 * If runPipeline throws inside the intercept, we must NOT fall through
 * to recordInbound() with the raw text — that would stamp the secret
 * into SQLite and emit it to Claude unscrubbed. The catch block must
 * drop the message (return) before reaching recordInbound().
 *
 * These assertions are structural so they don't depend on Bun-only
 * runtime deps; they inspect the source bytes directly.
 */
describe('secret-detect pipeline fail-closed contract', () => {
  const src = readFileSync(
    new URL('../server.ts', import.meta.url),
    'utf8',
  )

  it('has exactly one [secret-detect] pipeline error catch marker', () => {
    const matches = src.match(/\[secret-detect\] pipeline error/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('the catch block around runPipeline returns (does not fall through to recordInbound)', () => {
    const idx = src.indexOf('[secret-detect] pipeline error')
    expect(idx).toBeGreaterThan(0)

    // The fail-closed `return` must appear BEFORE the next recordInbound()
    // call anywhere in the file. We scan forward from the error-log marker
    // for the first top-level `return` statement (indented by 4 spaces,
    // matching the handleInbound body style).
    const tail = src.slice(idx)
    const returnMatch = tail.match(/\n {4}return\b/)
    expect(returnMatch).not.toBeNull()
    const returnOffset = returnMatch!.index!
    const recordOffset = tail.indexOf('recordInbound(')
    // recordInbound is further down the function body; the fail-closed
    // return must come first.
    expect(recordOffset).toBeGreaterThan(0)
    expect(returnOffset).toBeLessThan(recordOffset)
  })

  it('catch body warns the user that the message was dropped', () => {
    const idx = src.indexOf('[secret-detect] pipeline error')
    const tail = src.slice(idx, idx + 2000)
    // Look for a user-visible warning referencing the drop.
    expect(tail).toMatch(/dropped|NOT stored|crash/i)
  })

  it('no path exists where recordInbound is called with the raw effectiveText after a pipeline throw', () => {
    // Structural guarantee: between the catch marker and the next
    // recordInbound( call there must be a `return` — otherwise a thrown
    // pipeline error could flow through to recordInbound.
    const catchIdx = src.indexOf('[secret-detect] pipeline error')
    const afterCatch = src.slice(catchIdx)
    const recordIdx = afterCatch.indexOf('recordInbound(')
    expect(recordIdx).toBeGreaterThan(0)
    const gap = afterCatch.slice(0, recordIdx)
    expect(gap).toMatch(/\n\s*return\b/)
  })
})
