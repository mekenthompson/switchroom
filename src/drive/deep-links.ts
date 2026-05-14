/**
 * Open-in-Drive deep-link builders — RFC E §4.3.
 *
 * Pure functions that turn a Drive file's id + mimeType into the canonical
 * "open this in Drive" URL. Used by the approval kernel to render the
 * `[ 📖 Open in Drive ]` inline-keyboard button on every approval card
 * that names a doc, on grant-confirmation cards, and on suggestion-write
 * approvals (where the URL also carries the discussion-thread id so the
 * link lands on the proposed edit specifically).
 *
 * No new auth needed — these are the same shareable URLs the user would
 * copy from Drive's "Share" dialog.
 */

/**
 * Drive surfaces that have first-class web UIs. Other mime types (PDFs,
 * images, .docx, etc.) get the generic `/file/d/<id>/view` URL.
 */
export type DriveDocKind =
  | "doc"
  | "spreadsheet"
  | "presentation"
  | "form"
  | "drawing"
  | "folder"
  | "file";

/**
 * Map a Google Workspace mime type string to a DriveDocKind. Returns
 * "file" (the generic viewer) for anything we don't recognize as a
 * first-class Workspace surface.
 */
export function classifyMimeType(mimeType: string | undefined): DriveDocKind {
  if (!mimeType) return "file";
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "doc";
    case "application/vnd.google-apps.spreadsheet":
      return "spreadsheet";
    case "application/vnd.google-apps.presentation":
      return "presentation";
    case "application/vnd.google-apps.form":
      return "form";
    case "application/vnd.google-apps.drawing":
      return "drawing";
    case "application/vnd.google-apps.folder":
      return "folder";
    default:
      return "file";
  }
}

export interface OpenInDriveOptions {
  /**
   * Drive file id — the bare id, no slashes. Anything that looks like
   * a URL or contains a slash is rejected (defense against an agent
   * passing a crafted URL through to the inline-keyboard button text).
   */
  fileId: string;
  /**
   * mimeType from Drive's `files.get` response. Determines which
   * web-UI base we hit. Falls back to the generic file viewer if
   * unknown.
   */
  mimeType?: string;
  /**
   * Optional discussion-thread id — for suggestion-write approvals
   * where Drive exposes a discussion thread for the proposed edit.
   * Renders as `?disco=<id>` so the link lands on the suggestion
   * specifically (RFC E §4.3 last sub-bullet). Validated same shape
   * as fileId.
   */
  discussionId?: string;
  /**
   * Treat the target as a folder regardless of mimeType. Used by the
   * grant-confirmation card on `doc:gdrive:folder/<id>/**` scopes,
   * where we only have the scope string and no `files.get` lookup
   * has happened.
   */
  isFolder?: boolean;
}

/**
 * Build the canonical open-in-Drive URL for a file. Throws on any
 * input that doesn't pass the strict-id check (no slashes, no spaces,
 * no URL fragments) — these strings end up rendered as inline-keyboard
 * button URLs and need to be incapable of carrying smuggled paths or
 * query strings the agent didn't authorize.
 */
export function openInDriveUrl(options: OpenInDriveOptions): string {
  validateDriveId(options.fileId, "fileId");
  if (options.discussionId !== undefined) {
    validateDriveId(options.discussionId, "discussionId");
  }
  const kind = options.isFolder ? "folder" : classifyMimeType(options.mimeType);
  const base = baseUrlFor(kind, options.fileId);
  if (options.discussionId !== undefined) {
    // `?disco=<id>` is Drive's documented discussion-thread anchor.
    // We append it as a query string so it survives the Workspace
    // app's URL handlers on iOS/Android (fragments are sometimes
    // dropped by the deep-link router).
    return `${base}?disco=${encodeURIComponent(options.discussionId)}`;
  }
  return base;
}

function baseUrlFor(kind: DriveDocKind, fileId: string): string {
  switch (kind) {
    case "doc":
      return `https://docs.google.com/document/d/${fileId}/edit`;
    case "spreadsheet":
      return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
    case "presentation":
      return `https://docs.google.com/presentation/d/${fileId}/edit`;
    case "form":
      return `https://docs.google.com/forms/d/${fileId}/edit`;
    case "drawing":
      return `https://docs.google.com/drawings/d/${fileId}/edit`;
    case "folder":
      return `https://drive.google.com/drive/folders/${fileId}`;
    case "file":
      return `https://drive.google.com/file/d/${fileId}/view`;
  }
}

/**
 * Drive file ids are URL-safe base64-ish strings (alnum + `-_`). They
 * don't contain `/`, `?`, `#`, `:`, whitespace, or any URL syntax.
 * Anything else is either a smuggled URL fragment or a typo — reject
 * up front.
 *
 * We're permissive on length (Drive's id length isn't fixed) but
 * strict on character set.
 */
function validateDriveId(id: string, fieldName: string): void {
  if (id.length === 0) {
    throw new Error(`Drive ${fieldName} must not be empty`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `Drive ${fieldName} '${id.slice(0, 30)}${id.length > 30 ? "…" : ""}' contains invalid characters. Expected base64-url-safe (alphanumerics + - + _).`,
    );
  }
}

/**
 * Convenience builder for the common "render an inline-keyboard
 * button on an approval card" case. Returns the {text, url} pair the
 * Telegram bot library expects. Callers (gateway approval-card
 * builders, grant-confirmation edits) construct InlineKeyboardButton
 * objects directly from this; the literal `📖 Open in Drive` text
 * matches the RFC E §4.3 mockup.
 */
export function openInDriveButton(
  options: OpenInDriveOptions,
): { text: string; url: string } {
  return {
    text: "📖 Open in Drive",
    url: openInDriveUrl(options),
  };
}

/**
 * Inspect a kernel `scope` string and, if it points at a specific Drive
 * surface, return the {text, url} button pair for `[ 📖 Open in Drive ]`.
 * Returns `null` for non-Drive scopes and for the whole-Drive globs
 * (where there's no single artifact to deep-link to — the user can
 * navigate from `[ 📂 Open my Drive ]` instead; see `myDriveButton`).
 *
 * Handles all three action namespaces — `read` (`doc:gdrive:…`),
 * `suggest` (`doc:gdrive:suggest:…`), `write` (`doc:gdrive:write:…`) —
 * because once the user has tapped Allow, the target artifact is the
 * same in all three.
 *
 * Designed for the grant-confirmation card edit in
 * `telegram-plugin/gateway/approval-callback.ts`: the kernel returns
 * the scope alongside the consume result, this helper turns it into a
 * keyboard button, or null if no button applies. Callers that have a
 * mimeType (e.g. a diff-preview card with the file already fetched)
 * should pass it via `mimeTypeHint` so doc/sheet/slide gets the right
 * base URL; otherwise we infer from scope shape.
 */
export function scopeToOpenInDriveButton(
  scope: string,
  mimeTypeHint?: string,
): { text: string; url: string } | null {
  const parsed = parseDriveScope(scope);
  if (parsed === null) return null;
  if (parsed.target.kind === "all") return null;
  if (parsed.target.kind === "folder") {
    return openInDriveButton({ fileId: parsed.target.folder_id, isFolder: true });
  }
  return openInDriveButton({
    fileId: parsed.target.doc_id,
    mimeType: mimeTypeHint,
  });
}

/**
 * Whole-Drive equivalent of `openInDriveButton`. For onboarding /
 * granted-Drive scopes like `doc:gdrive:**` where no specific artifact
 * exists, surfacing a `[ 📂 Open my Drive ]` URL button is the closest
 * useful affordance.
 */
export function myDriveButton(): { text: string; url: string } {
  return {
    text: "📂 Open my Drive",
    url: "https://drive.google.com/drive/my-drive",
  };
}

export type DriveScopeTarget =
  | { kind: "all" }
  | { kind: "folder"; folder_id: string }
  | { kind: "doc"; doc_id: string };

export interface DriveScope {
  /** Action namespace per RFC E §4.2 + grants.ts. */
  action: "read" | "suggest" | "write";
  target: DriveScopeTarget;
}

/**
 * Parse a kernel scope string into its action namespace + target. Returns
 * `null` for anything that doesn't look like a Drive scope. Strict on
 * id character set to prevent a malformed scope from rendering an unsafe
 * URL — same `[A-Za-z0-9_-]+` rule as `validateDriveId`.
 */
export function parseDriveScope(scope: string): DriveScope | null {
  if (!scope.startsWith("doc:gdrive:")) return null;
  let rest = scope.slice("doc:gdrive:".length);
  let action: DriveScope["action"] = "read";
  if (rest.startsWith("write:")) {
    action = "write";
    rest = rest.slice("write:".length);
  } else if (rest.startsWith("suggest:")) {
    action = "suggest";
    rest = rest.slice("suggest:".length);
  }
  if (rest === "**") return { action, target: { kind: "all" } };
  if (rest.startsWith("folder/")) {
    const tail = rest.slice("folder/".length);
    if (!tail.endsWith("/**")) return null;
    const folder_id = tail.slice(0, -"/**".length);
    if (!/^[A-Za-z0-9_-]+$/.test(folder_id)) return null;
    return { action, target: { kind: "folder", folder_id } };
  }
  // Single-doc form. Must be a bare id — no slashes, no glob.
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) return null;
  return { action, target: { kind: "doc", doc_id: rest } };
}
