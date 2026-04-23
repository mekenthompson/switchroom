import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural integration test for the secret-detect intercept in the
 * gateway's handleInbound.
 *
 * Why structural: gateway/gateway.ts does not export handleInbound, so a
 * pure-functional invocation would require either a refactor (risky for
 * a security fix) or end-to-end harnessing of Bot/Grammy/Context. The
 * pipeline itself is exhaustively unit-tested in
 * `secret-detect-pipeline.test.ts` and `secret-detect.test.ts`, and the
 * fail-closed contract has its own structural test
 * (`secret-detect-fail-closed.test.ts`). What's left to assert here is:
 *   1. The gateway actually wires runPipeline into handleInbound.
 *   2. The intercept sits AFTER the auth/vault intercepts (those bypass
 *      the LLM entirely; secret-detect must run on text that survived
 *      them).
 *   3. The intercept sits BEFORE recordInbound() and ipcServer.broadcast()
 *      (those are the sinks that would leak raw bytes to SQLite + agent).
 *   4. Both the cached-passphrase store path and the no-passphrase
 *      deferred-warning path are present.
 *
 * If a future refactor moves the intercept into the wrong slot, these
 * assertions break and the security regression is caught at build time
 * rather than live.
 */
describe('gateway secret-detect intercept — structural wiring', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('imports the pipeline + staging modules', () => {
    expect(src).toMatch(/from '\.\.\/secret-detect\/pipeline\.js'/)
    expect(src).toMatch(/from '\.\.\/secret-detect\/staging\.js'/)
    expect(src).toMatch(/from '\.\.\/secret-detect\/vault-write\.js'/)
    expect(src).toMatch(/from '\.\.\/secret-detect\/index\.js'/)
  })

  it('invokes runPipeline inside handleInbound', () => {
    const handleInboundIdx = src.indexOf('async function handleInbound(')
    expect(handleInboundIdx).toBeGreaterThan(0)
    const pipelineIdx = src.indexOf('runPipeline({', handleInboundIdx)
    expect(pipelineIdx).toBeGreaterThan(0)
  })

  it('runPipeline call sits AFTER the vault intercept', () => {
    const vaultIdx = src.indexOf('// Vault intercept')
    const pipelineIdx = src.indexOf('runPipeline({')
    expect(vaultIdx).toBeGreaterThan(0)
    expect(pipelineIdx).toBeGreaterThan(0)
    expect(pipelineIdx).toBeGreaterThan(vaultIdx)
  })

  it('runPipeline call sits BEFORE recordInbound() and ipcServer.broadcast(inboundMsg)', () => {
    const pipelineIdx = src.indexOf('runPipeline({')
    const recordIdx = src.indexOf('recordInbound(', pipelineIdx)
    const broadcastIdx = src.indexOf('ipcServer.broadcast(inboundMsg)', pipelineIdx)
    expect(pipelineIdx).toBeGreaterThan(0)
    expect(recordIdx).toBeGreaterThan(pipelineIdx)
    expect(broadcastIdx).toBeGreaterThan(pipelineIdx)
  })

  it('cached-passphrase path: rewrites effectiveText, deletes message, posts masked summary', () => {
    const pipelineIdx = src.indexOf('runPipeline({')
    const tail = src.slice(pipelineIdx, pipelineIdx + 4000)
    // Rewrites effectiveText so the broadcast carries the redacted text.
    expect(tail).toMatch(/effectiveText = pipeRes\.rewritten_text/)
    // Deletes the original Telegram message containing the raw bytes.
    expect(tail).toMatch(/bot\.api\.deleteMessage\(chat_id, msgId\)/)
    // Tells the user what was captured (masked).
    expect(tail).toMatch(/captured \$\{pipeRes\.stored\.length\} secret/)
    // Surfaces the masked form (s.masked is computed via maskToken in the pipeline).
    expect(tail).toMatch(/s\.masked/)
  })

  it('no-passphrase deferred path: warns user, deletes message, returns (no broadcast)', () => {
    const pipelineIdx = src.indexOf('runPipeline({')
    const tail = src.slice(pipelineIdx, pipelineIdx + 6000)
    expect(tail).toMatch(/no vault passphrase is cached/)
    expect(tail).toMatch(/this message was NOT stored/)
    // Both branches of the deferred path must `return` so we don't fall
    // through to recordInbound/broadcast with raw bytes.
    const deferredIdx = tail.indexOf('this message was NOT stored')
    const afterDeferred = tail.slice(deferredIdx)
    expect(afterDeferred).toMatch(/\n\s*return\b/)
  })

  it('detectSecrets is used for the deferred peek (no-passphrase path)', () => {
    expect(src).toMatch(/const detections = detectSecrets\(effectiveText\)/)
  })

  it('staging follow-up commands (stash/ignore/rename/forget) are wired', () => {
    const handleInboundIdx = src.indexOf('async function handleInbound(')
    const tail = src.slice(handleInboundIdx, handleInboundIdx + 30000)
    expect(tail).toMatch(/\(stash\|ignore\|rename\|forget\)/)
    expect(tail).toMatch(/secretStaging\.latestForChat\(chat_id\)/)
  })
})
