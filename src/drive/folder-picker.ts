/**
 * Folder picker card builder — RFC E §4.1.
 *
 * Pure card-spec assembler. Takes a `FolderPage` (from `folder-list.ts`)
 * + a few render-time options and returns a structured
 * `FolderPickerCardSpec` that the Telegram gateway turns into a
 * sendMessage payload (text + inline_keyboard).
 *
 * Kept separate from the Telegram-specific renderer so the keyboard
 * shape, button count, and pagination state are independently
 * unit-testable without grammy in the loop. The gateway wire-up lands
 * in a follow-up — same shipped-helper-then-wire pattern as anchors
 * (#1250), diff-preview (#1252), deep-links (#1251), recovery detector
 * (#1249).
 *
 * Callback wire format (fits Telegram's 64-byte cap):
 *
 *   drvpick:open:<agent>[:<parent_id>][:<page_token>]
 *     Open / paginate the picker. Used by the gateway when
 *     re-rendering after a tap.
 *   drvpick:enter:<agent>:<folder_id>
 *     Drill into a sub-folder (RFC §4.1 "tap on a folder = expand
 *     into its children").
 *   drvpick:back:<agent>[:<parent_id>]
 *     One level up. parent_id is the level we're returning TO.
 *     Empty parent_id == top of Drive.
 *   drvpick:refresh:<agent>[:<parent_id>]
 *     Bypass the 5-min cache and re-fetch (RFC §4.1 last bullet).
 *   drvpick:grant:<agent>:<folder_id>
 *     Allow the highlighted folder — gateway invokes the standard
 *     approval-kernel `allow_always` write at
 *     `doc:gdrive:folder/<folder_id>/**`.
 *
 * Agent names are URL-encoded at emit and validated on parse — same
 * defense the operator-events module uses (issue #24).
 */

import type { DriveFolder, FolderPage } from "./folder-list.js";

const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]*$/i;

/**
 * Input to the card builder. Most fields come straight from the
 * folder-list fetch; `breadcrumb` is the chain of parent folders the
 * user has drilled into, used to render `📁 /Work/2026/Q3` in the
 * card title.
 */
export interface FolderPickerCardInput {
  agent: string;
  /** Folder list to render (page-0 from cache, or a paginated page). */
  page: FolderPage;
  /** Parent folder being viewed; undefined == top of Drive. */
  parent?: { id: string; name: string };
  /**
   * Breadcrumb path from top-of-Drive down to the current parent.
   * Empty when `parent` is undefined. Each entry is a {id, name} pair
   * the back-stack can navigate into.
   */
  breadcrumb?: Array<{ id: string; name: string }>;
  /**
   * When set, the gateway is re-rendering after the user already
   * navigated past page 0 — show the [Prev N] button as well as
   * [Next N] when there's a `previous_page_token`.
   */
  previous_page_token?: string;
}

export interface FolderPickerButton {
  text: string;
  callback_data: string;
}

export interface FolderPickerCardSpec {
  /** Telegram message text (plain — gateway HTML-escapes at send). */
  body: string;
  /**
   * inline_keyboard rows. Folder rows come first (one folder per row
   * with a label-only display), followed by nav rows ([ ⬅ Back ] /
   * [ ↻ Refresh ] / [ Next N ]) and the action row ([ ✅ Allow this
   * folder ] when a folder is selected).
   */
  rows: FolderPickerButton[][];
}

/**
 * Build the picker card. Returns a structured shape, not a Telegram
 * sendMessage payload — that translation lives in the gateway wire-up.
 *
 * The "selected" model is implicit: each `📁 <name>` row is itself an
 * Allow-this-folder tap. RFC §4.1 originally split into [open folder]
 * + [allow this folder], but in practice the tap-target ambiguity is
 * worse than a dedicated `[ 📂 Drill in ]` button per folder. We
 * resolve it by making the folder row a direct grant, and adding a
 * trailing `[ 📂 Browse <name> ]` row when the folder has sub-folders
 * the user might want to scope-down into. (Whether sub-folders exist
 * is unknown at picker-build time — every folder gets the browse
 * affordance.)
 */
export function buildFolderPickerCard(
  input: FolderPickerCardInput,
): FolderPickerCardSpec {
  validateAgentName(input.agent);
  const rows: FolderPickerButton[][] = [];

  const headerLines: string[] = [];
  if (input.parent !== undefined) {
    validateDriveId(input.parent.id, "parent.id");
    const path = renderBreadcrumb(input.breadcrumb ?? [], input.parent.name);
    headerLines.push(`📁 ${path}`);
  } else {
    headerLines.push("📁 Pick a folder to grant access to");
  }
  if (input.page.folders.length === 0) {
    headerLines.push("(no sub-folders here)");
  } else {
    headerLines.push(
      input.page.folders.length === 1
        ? "1 folder. Tap to allow, or browse into it."
        : `${input.page.folders.length} folders. Tap one to allow, or browse into it.`,
    );
  }
  const body = headerLines.join("\n");

  for (const folder of input.page.folders) {
    validateDriveId(folder.id, "folder.id");
    rows.push([
      {
        text: `✅ Allow "${truncateName(folder.name, 48)}"`,
        callback_data: encodeCallback(["drvpick", "grant", input.agent, folder.id]),
      },
    ]);
    rows.push([
      {
        text: `📂 Browse "${truncateName(folder.name, 46)}"`,
        callback_data: encodeCallback(["drvpick", "enter", input.agent, folder.id]),
      },
    ]);
  }

  const navRow: FolderPickerButton[] = [];
  if (input.parent !== undefined) {
    const upTo = input.breadcrumb && input.breadcrumb.length > 0
      ? input.breadcrumb[input.breadcrumb.length - 1]!.id
      : "";
    navRow.push({
      text: "⬅ Back",
      callback_data: encodeCallback(["drvpick", "back", input.agent, upTo]),
    });
  }
  navRow.push({
    text: "↻ Refresh",
    callback_data: encodeCallback([
      "drvpick",
      "refresh",
      input.agent,
      input.parent?.id ?? "",
    ]),
  });
  if (input.page.next_page_token !== undefined) {
    navRow.push({
      text: "Next ▶",
      callback_data: encodeCallback([
        "drvpick",
        "open",
        input.agent,
        input.parent?.id ?? "",
        input.page.next_page_token,
      ]),
    });
  }
  rows.push(navRow);

  // Enforce Telegram's 64-byte callback_data cap on every emitted
  // button. The agent name is the only variable-length component
  // (folder ids + tokens are bounded by Drive's own shapes). A name
  // pushing 30 chars + a Drive id of 44 chars + the prefix would
  // exceed the cap — fail loudly at build time rather than at send.
  for (const row of rows) {
    for (const btn of row) {
      if (Buffer.byteLength(btn.callback_data, "utf8") > 64) {
        throw new Error(
          `folder-picker callback_data exceeds Telegram's 64-byte cap: ${btn.callback_data} (${Buffer.byteLength(btn.callback_data, "utf8")} bytes)`,
        );
      }
    }
  }

  return { body, rows };
}

function renderBreadcrumb(
  trail: Array<{ id: string; name: string }>,
  leafName: string,
): string {
  const leaf = truncateName(leafName, 24);
  if (trail.length === 0) return `/${leaf}`;
  const segments = trail.map((t) => truncateName(t.name, 20));
  segments.push(leaf);
  return `/${segments.join("/")}`;
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

/**
 * Callback parser — inverse of `encodeCallback`. Returns `null` on a
 * malformed string so the gateway can pass through to the next
 * dispatcher branch.
 *
 * Strict on the verb set + id charsets so a crafted callback can't
 * smuggle anything past the dispatcher into the kernel.
 */
export type FolderPickerCallback =
  | { kind: "open"; agent: string; parent_id?: string; page_token?: string }
  | { kind: "enter"; agent: string; folder_id: string }
  | { kind: "back"; agent: string; parent_id?: string }
  | { kind: "refresh"; agent: string; parent_id?: string }
  | { kind: "grant"; agent: string; folder_id: string };

export function parseFolderPickerCallback(
  data: string,
): FolderPickerCallback | null {
  if (!data.startsWith("drvpick:")) return null;
  const parts = data.split(":");
  // drvpick:<verb>:<agent>[:<...>]
  if (parts.length < 3) return null;
  const verb = parts[1];
  const agentEncoded = parts[2] ?? "";
  let agent: string;
  try {
    agent = decodeURIComponent(agentEncoded);
  } catch {
    return null;
  }
  if (!AGENT_NAME_RE.test(agent)) return null;

  switch (verb) {
    case "open": {
      const parent = parts[3] ?? "";
      const token = parts[4] ?? "";
      if (parent !== "" && !DRIVE_ID_RE.test(parent)) return null;
      // Page tokens are opaque to us but Drive emits them as
      // alphanumeric-ish strings; accept the same charset to keep
      // the inline-keyboard URL safe.
      if (token !== "" && !/^[A-Za-z0-9_-]+$/.test(token)) return null;
      return {
        kind: "open",
        agent,
        ...(parent !== "" ? { parent_id: parent } : {}),
        ...(token !== "" ? { page_token: token } : {}),
      };
    }
    case "enter": {
      const folder = parts[3] ?? "";
      if (!DRIVE_ID_RE.test(folder)) return null;
      return { kind: "enter", agent, folder_id: folder };
    }
    case "back": {
      const parent = parts[3] ?? "";
      if (parent !== "" && !DRIVE_ID_RE.test(parent)) return null;
      return {
        kind: "back",
        agent,
        ...(parent !== "" ? { parent_id: parent } : {}),
      };
    }
    case "refresh": {
      const parent = parts[3] ?? "";
      if (parent !== "" && !DRIVE_ID_RE.test(parent)) return null;
      return {
        kind: "refresh",
        agent,
        ...(parent !== "" ? { parent_id: parent } : {}),
      };
    }
    case "grant": {
      const folder = parts[3] ?? "";
      if (!DRIVE_ID_RE.test(folder)) return null;
      return { kind: "grant", agent, folder_id: folder };
    }
    default:
      return null;
  }
}

function encodeCallback(parts: string[]): string {
  // Only the agent name might need URL-encoding; folder ids + page
  // tokens have been charset-validated already.
  return parts
    .map((p, i) => (i === 2 ? encodeURIComponent(p) : p))
    .join(":");
}

function validateAgentName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `folder-picker agent name must match /^[a-z][a-z0-9_-]*$/i — got '${name}'`,
    );
  }
}

function validateDriveId(id: string, fieldName: string): void {
  if (!DRIVE_ID_RE.test(id)) {
    throw new Error(
      `folder-picker ${fieldName} '${id.slice(0, 30)}${id.length > 30 ? "…" : ""}' contains invalid characters. Expected base64-url-safe (alphanumerics + - + _).`,
    );
  }
}

/** Re-export for callers that want to compose a card from raw folders. */
export type { DriveFolder, FolderPage };
