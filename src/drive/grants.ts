/**
 * Drive grants — scope shapes + namespace separation per RFC D §12 and RFC E §4.2.
 *
 * Three action namespaces:
 *
 *   read     (default; non-mutating)
 *     doc:gdrive:**                  whole-Drive read
 *     doc:gdrive:folder/<id>/**      folder + descendants
 *     doc:gdrive:<id>                single doc
 *
 *   suggest  (non-destructive proposal — RFC E §4.2, lands as a Drive Suggestion)
 *     doc:gdrive:suggest:**
 *     doc:gdrive:suggest:folder/<id>/**
 *     doc:gdrive:suggest:<id>
 *
 *   write    (direct mutation — RFC D §12, RFC E §4.2)
 *     doc:gdrive:write:**
 *     doc:gdrive:write:folder/<id>/**
 *     doc:gdrive:write:<id>
 *
 * Implication rules (RFC E §4.2):
 *   - A `write` grant implies `suggest` on the same target. The user
 *     authorised something stronger; honouring a non-destructive proposal
 *     under the same authorisation is strictly less privileged.
 *   - A `suggest` grant does NOT imply `write`. The whole point of
 *     Suggesting mode is that the user reviews each change in Drive
 *     before it lands; a standing direct-write authorisation is a
 *     materially different decision.
 *   - Read does not cross into either mutation namespace, and neither
 *     mutation namespace fulfils a read request (mutation grants are
 *     scope-distinct so the kernel's prefix matcher already rejects).
 *
 * The kernel's scope-prefix matching (RFC B) handles the `**` glob. This
 * module provides `scopeFor()` to build the kernel `scope` string for a
 * target + action, `actionGrammar()` to map an operation to the action
 * keyword stored on the decision row, and `canFulfill()` to assert at
 * lookup time that a candidate decision actually authorises the
 * requested action — including the `write → suggest` implication.
 */

export type DriveAction = "read" | "suggest" | "write";

export type DriveTarget =
  | { kind: "all" }
  | { kind: "folder"; folder_id: string }
  | { kind: "doc"; doc_id: string };

/** Build the kernel `scope` string for a given target + action. */
export function scopeFor(target: DriveTarget, action: DriveAction): string {
  const actionPrefix = action === "read" ? "" : `${action}:`;
  switch (target.kind) {
    case "all":
      return `doc:gdrive:${actionPrefix}**`;
    case "folder":
      return `doc:gdrive:${actionPrefix}folder/${target.folder_id}/**`;
    case "doc":
      return `doc:gdrive:${actionPrefix}${target.doc_id}`;
  }
}

/** action_grammar value to store on the kernel decision row. */
export function actionGrammar(action: DriveAction): string {
  return action;
}

/**
 * Predicate: can a decision recorded for `decisionScope` (with its stored
 * `action_grammar`) fulfil an incoming request for `requestedScope` +
 * `requestedAction`?
 *
 * Enforces the namespace + implication rules in the module header.
 */
export function canFulfill(args: {
  decisionScope: string;
  decisionAction: string;
  requestedScope: string;
  requestedAction: DriveAction;
}): boolean {
  // Action implication. Same-action always allowed (subject to scope check
  // below). The single cross-action allowance is `write` decision → `suggest`
  // request; nothing else crosses.
  const sameAction = args.decisionAction === args.requestedAction;
  const writeFulfilsSuggest =
    args.decisionAction === "write" && args.requestedAction === "suggest";
  if (!sameAction && !writeFulfilsSuggest) return false;

  const decisionNs = scopeNamespace(args.decisionScope);
  const requestedNs = scopeNamespace(args.requestedScope);

  // Same namespace: ordinary prefix match.
  if (decisionNs === requestedNs) {
    return prefixMatches(args.decisionScope, args.requestedScope);
  }

  // Cross-namespace only allowed when write fulfils suggest. Rewrite the
  // request into the write namespace and prefix-match against the decision.
  if (writeFulfilsSuggest && decisionNs === "write" && requestedNs === "suggest") {
    const rewritten = args.requestedScope.replace(
      /^doc:gdrive:suggest:/,
      "doc:gdrive:write:",
    );
    return prefixMatches(args.decisionScope, rewritten);
  }

  return false;
}

export type DriveNamespace = "read" | "suggest" | "write";

/** Classify a scope string by its action namespace. */
export function scopeNamespace(scope: string): DriveNamespace {
  if (scope.startsWith("doc:gdrive:write:")) return "write";
  if (scope.startsWith("doc:gdrive:suggest:")) return "suggest";
  return "read";
}

/**
 * Trivial prefix matcher mirroring RFC B's scope semantics:
 *   `foo:**` matches `foo:anything`.
 *   `foo:bar/**` matches `foo:bar/anything`.
 *   exact strings match themselves.
 *
 * The real kernel matcher is more elaborate; here we only need enough to
 * correctly answer "does this decision authorise this request" for unit
 * tests of the namespace + implication rules.
 */
export function prefixMatches(decisionScope: string, requestedScope: string): boolean {
  if (decisionScope === requestedScope) return true;
  if (decisionScope.endsWith("/**")) {
    const prefix = decisionScope.slice(0, -2); // keep trailing slash
    return requestedScope.startsWith(prefix);
  }
  if (decisionScope.endsWith(":**")) {
    const prefix = decisionScope.slice(0, -2); // keep trailing colon
    return requestedScope.startsWith(prefix);
  }
  return false;
}
