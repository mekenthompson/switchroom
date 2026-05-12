/**
 * Helper for the `switchroom setup` posture-prompt step that writes
 * `vault.broker.approvalAuth: telegram-id` into the operator's
 * `switchroom.yaml`.
 *
 * Extracted from setup.ts so the rewrite can be exercised in unit
 * tests without spawning the interactive setup flow. The reviewer
 * called out the original regex (`^(\s+)broker:\s*\n`) as fragile:
 * it would match ANY `broker:` key in the YAML, not just the one
 * nested under `vault:` — landing the posture key under the wrong
 * block if e.g. a sibling top-level `broker:` existed.
 *
 * Behaviour pinned by `setup-posture-rewrite.test.ts`:
 *   - Insertion lands under `vault.broker:` only.
 *   - A sibling top-level `broker:` is NOT touched.
 *   - If `vault: > broker:` cannot be located, the rewrite is
 *     refused (the helper returns a `not-found` result; the caller
 *     surfaces a manual-edit hint instead of landing the key under
 *     the wrong block).
 *   - If `approvalAuth:` already exists anywhere under `vault.broker`,
 *     the rewrite is a no-op.
 *   - User comments and surrounding formatting are preserved — we
 *     do not round-trip through a stringify-everything YAML emit.
 */

import YAML from 'yaml'

export type PostureRewriteResult =
  | { kind: 'rewritten'; content: string }
  | { kind: 'already-set' }
  | { kind: 'not-found' }

/**
 * Insert `approvalAuth: telegram-id` under the `vault.broker:` mapping.
 *
 * Strategy: parse the YAML to a Document with a CST so we can ask the
 * parser to locate the `vault > broker` mapping unambiguously, then
 * do a surgical text edit at that block's start so comments and
 * formatting are preserved. We DON'T stringify the whole doc — that
 * would reformat the operator's file.
 */
export function insertVaultBrokerApprovalAuth(
  source: string,
  value: 'telegram-id' | 'passphrase' = 'telegram-id',
): PostureRewriteResult {
  let doc: YAML.Document.Parsed
  try {
    doc = YAML.parseDocument(source)
  } catch {
    return { kind: 'not-found' }
  }
  const vault = doc.get('vault') as YAML.YAMLMap | undefined
  if (!vault || !YAML.isMap(vault)) {
    return { kind: 'not-found' }
  }
  const broker = vault.get('broker') as YAML.YAMLMap | undefined
  if (!broker || !YAML.isMap(broker)) {
    return { kind: 'not-found' }
  }
  // Already set?
  if (broker.has('approvalAuth')) {
    return { kind: 'already-set' }
  }

  // Locate the broker block's range in the source so we can insert a
  // sibling key under it without touching anything else.
  const brokerRange = broker.range
  if (!brokerRange) {
    return { kind: 'not-found' }
  }
  // Determine the broker block's child indent. We use the first key's
  // column as the indent. If broker is empty (no children yet), fall
  // back to the broker's own indent + 2 spaces.
  let childIndent: string
  if (broker.items.length > 0) {
    const firstKey = broker.items[0]?.key as YAML.Scalar | undefined
    const firstKeyRange = firstKey?.range
    if (firstKeyRange) {
      // Walk backwards from firstKey start to the prior newline to get
      // the leading whitespace.
      const start = firstKeyRange[0]
      const lineStart = source.lastIndexOf('\n', start - 1) + 1
      childIndent = source.slice(lineStart, start)
    } else {
      childIndent = '  '
    }
  } else {
    // Find broker key's own column, add 2.
    const brokerKeyItem = vault.items.find(it => {
      const k = it.key as YAML.Scalar
      return k && k.value === 'broker'
    })
    const brokerKey = brokerKeyItem?.key as YAML.Scalar | undefined
    const brokerKeyRange = brokerKey?.range
    if (brokerKeyRange) {
      const start = brokerKeyRange[0]
      const lineStart = source.lastIndexOf('\n', start - 1) + 1
      const ownIndent = source.slice(lineStart, start)
      childIndent = ownIndent + '  '
    } else {
      childIndent = '    '
    }
  }

  // Insert at the END of the broker block — value-range [start, valueEnd, nodeEnd].
  // range[1] is the end of the value (children), range[2] includes trailing
  // whitespace. We want to insert just before the next sibling under vault
  // (or end of file). Use the broker's value-end offset, then back up past
  // any trailing whitespace so we land cleanly after the last child.
  const valueEnd = brokerRange[1]
  // Back up over trailing whitespace + newlines so we insert AFTER the
  // last child's line, with our own newline.
  let insertAt = valueEnd
  while (insertAt > 0 && /\s/.test(source[insertAt - 1] ?? '')) {
    insertAt--
  }
  // Now insertAt points just after the last non-whitespace char of the
  // broker block. Insert "\n<indent>approvalAuth: telegram-id" and let
  // any pre-existing trailing whitespace stay where it was.
  const insertion = `\n${childIndent}approvalAuth: ${value}`
  const rewritten = source.slice(0, insertAt) + insertion + source.slice(insertAt)
  return { kind: 'rewritten', content: rewritten }
}
