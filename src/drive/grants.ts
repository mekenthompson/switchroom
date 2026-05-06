/**
 * Drive grants — scope shapes + write-namespace separation per RFC C §12.
 *
 * Read scopes:
 *   doc:gdrive:**                  whole-Drive read (default onboarding pick)
 *   doc:gdrive:folder/<id>/**      folder + descendants
 *   doc:gdrive:<id>                single doc
 *
 * Write scopes (separate namespace — a read grant NEVER fulfills a write):
 *   doc:gdrive:write:**
 *   doc:gdrive:write:folder/<id>/**
 *   doc:gdrive:write:<id>
 *
 * The kernel's scope-prefix matching (RFC B) handles the `**` glob. This
 * module provides `scopeForRead/Write()` builders, `actionGrammar()` to map
 * an operation to the action keyword stored on the decision row, and
 * `canFulfill()` to assert at lookup time that a candidate decision actually
 * authorizes the requested action.
 */

export type DriveAction = "read" | "write";

export type DriveTarget =
  | { kind: "all" }
  | { kind: "folder"; folder_id: string }
  | { kind: "doc"; doc_id: string };

/** Build the kernel `scope` string for a given target + action. */
export function scopeFor(target: DriveTarget, action: DriveAction): string {
  const writePrefix = action === "write" ? "write:" : "";
  switch (target.kind) {
    case "all":
      return `doc:gdrive:${writePrefix}**`;
    case "folder":
      return `doc:gdrive:${writePrefix}folder/${target.folder_id}/**`;
    case "doc":
      return `doc:gdrive:${writePrefix}${target.doc_id}`;
  }
}

/** action_grammar value to store on the kernel decision row. */
export function actionGrammar(action: DriveAction): string {
  return action;
}

/**
 * Predicate: can a decision recorded for `decisionScope` (with its stored
 * `action_grammar`) fulfill an incoming request for `requestedScope` +
 * `requestedAction`?
 *
 * Hard constraint per §12: read grants do NOT fulfill write requests, even
 * when the doc/folder id matches. This is enforced here regardless of what
 * the kernel's scope-prefix matcher might say — the write namespace prefix
 * (`doc:gdrive:write:`) is structurally distinct so the kernel matcher
 * already rejects, but we double-check by looking at the action_grammar.
 */
export function canFulfill(args: {
  decisionScope: string;
  decisionAction: string;
  requestedScope: string;
  requestedAction: DriveAction;
}): boolean {
  // Action mismatch — always reject.
  if (args.decisionAction !== args.requestedAction) return false;

  // Both scopes must live in the SAME namespace (read vs write). A read
  // scope cannot match a write request even if the kernel's prefix matcher
  // is loosened in future.
  const decisionIsWrite = args.decisionScope.startsWith("doc:gdrive:write:");
  const requestedIsWrite = args.requestedScope.startsWith("doc:gdrive:write:");
  if (decisionIsWrite !== requestedIsWrite) return false;

  // Prefix match (handles `**` globs the kernel stores literally).
  return prefixMatches(args.decisionScope, args.requestedScope);
}

/**
 * Trivial prefix matcher mirroring RFC B's scope semantics:
 *   `foo:**` matches `foo:anything`.
 *   `foo:bar/**` matches `foo:bar/anything`.
 *   exact strings match themselves.
 *
 * The real kernel matcher is more elaborate; here we only need enough to
 * correctly answer "does this decision authorize this request" for unit
 * tests of the write-isolation rule.
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
