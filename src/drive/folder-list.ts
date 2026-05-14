/**
 * Drive folder listing — RFC E §4.1.
 *
 * Pure HTTP client + per-agent cache for the folder picker. Issues
 * `files.list` against Drive v3 with a fixed query that returns only
 * the caller's own folders (`'me' in owners`), skipping trashed
 * folders. Used by the Telegram-side folder picker card to render
 * `[ 📁 <folder name> ]` rows without forcing the user to hand-type
 * `doc:gdrive:folder/<id>/**`.
 *
 * The HTTP client and the cache are exported as separate primitives:
 *
 *   - `fetchFolderPage()` — pure HTTP call. No caching, no auth refresh.
 *     Caller supplies the access token (the existing `DriveTokenCache`
 *     in `wrapper.ts` handles refresh).
 *
 *   - `FolderListCache` — per-agent 5-min TTL cache. Holds the
 *     first-page payload only (the common navigation case). Cache
 *     bypass on `forceRefresh: true` for the `[ ↻ Refresh ]` button.
 *
 * Deliberately split so callers can mix freely — a folder-picker that
 * paginates deep into the list goes uncached page-by-page; the
 * happy-path "open the picker" case hits the cache.
 */

/**
 * Folder fields exposed by the picker. Trimmed deliberately — anything
 * the picker doesn't render (modified time, ownership, capabilities)
 * stays out of the response shape so we don't accidentally surface
 * fields the user didn't see.
 */
export interface DriveFolder {
  id: string;
  name: string;
  /**
   * Parent folder id, if any. Drive returns up to one parent per
   * folder in v3 (single-parent model after 2020). `undefined` for
   * top-of-Drive folders.
   */
  parent_id?: string;
}

export interface FolderPage {
  folders: DriveFolder[];
  /**
   * Drive's `nextPageToken` — pass to the next `fetchFolderPage()`
   * call to walk forward. `undefined` when there are no more pages.
   */
  next_page_token?: string;
}

export interface FetchFolderPageOptions {
  access_token: string;
  page_token?: string;
  /**
   * Page size — Drive's `files.list` accepts 1–1000. The picker UX
   * defaults to 50 (RFC E §4.1) which fits comfortably in a single
   * Telegram message; larger sizes spill into pagination state.
   */
  page_size?: number;
  /**
   * When set, restricts to folders that have this id as a parent —
   * used by sub-folder navigation (RFC E §4.1 "One tap on a folder =
   * expand into its children"). Validated to the same id charset as
   * other Drive ids; throws on smuggled URL fragments.
   */
  parent_id?: string;
  /** Test injection seam. */
  fetchImpl?: typeof fetch;
}

const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * One page of folders. Throws on auth failure (401), rate limit (429),
 * or a non-2xx response from Drive. The caller is responsible for
 * mapping 401 → "drive disconnected" via the existing invalid-grant
 * machinery in `wrapper.ts`.
 */
export async function fetchFolderPage(
  opts: FetchFolderPageOptions,
): Promise<FolderPage> {
  if (opts.parent_id !== undefined) {
    if (!DRIVE_ID_RE.test(opts.parent_id)) {
      throw new Error(
        `Drive parent_id contains invalid characters. Expected base64-url-safe (alphanumerics + - + _).`,
      );
    }
  }
  const pageSize = clampPageSize(opts.page_size ?? 50);

  // Drive's `q` parameter — folder mime, owned by the caller, not
  // trashed, optionally scoped to a parent. The parent_id has already
  // been charset-validated above so it's safe to interpolate.
  const qParts = [
    `mimeType='${FOLDER_MIME}'`,
    `'me' in owners`,
    `trashed=false`,
  ];
  if (opts.parent_id !== undefined) {
    qParts.push(`'${opts.parent_id}' in parents`);
  }

  const params = new URLSearchParams({
    q: qParts.join(" and "),
    pageSize: String(pageSize),
    // Drive responds with all fields by default; trim to what the
    // picker actually uses. Names are space-separated within parens
    // (Drive's `fields` mini-language).
    fields: "files(id,name,parents),nextPageToken",
    orderBy: "name",
  });
  if (opts.page_token !== undefined) {
    params.set("pageToken", opts.page_token);
  }

  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const resp = await (opts.fetchImpl ?? fetch)(url, {
    headers: {
      Authorization: `Bearer ${opts.access_token}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await safeReadText(resp);
    throw new Error(
      `Drive files.list failed: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const json = (await resp.json()) as {
    files?: Array<{ id?: string; name?: string; parents?: string[] }>;
    nextPageToken?: string;
  };

  const folders: DriveFolder[] = [];
  for (const f of json.files ?? []) {
    if (typeof f.id !== "string" || typeof f.name !== "string") continue;
    if (!DRIVE_ID_RE.test(f.id)) {
      // Drive returns trusted ids, but the picker turns the id into
      // a kernel scope string and a deep-link URL — a defensive guard
      // costs nothing and closes the supply-chain seam.
      continue;
    }
    const parent =
      Array.isArray(f.parents) && f.parents.length > 0
        ? f.parents[0]
        : undefined;
    folders.push({
      id: f.id,
      name: f.name,
      ...(typeof parent === "string" && DRIVE_ID_RE.test(parent)
        ? { parent_id: parent }
        : {}),
    });
  }
  return {
    folders,
    ...(typeof json.nextPageToken === "string"
      ? { next_page_token: json.nextPageToken }
      : {}),
  };
}

function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return 50;
  if (n < 1) return 1;
  if (n > 1000) return 1000;
  return Math.floor(n);
}

async function safeReadText(resp: Response): Promise<string | null> {
  try {
    const t = await resp.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return null;
  }
}

/**
 * Per-agent first-page cache with a 5-minute TTL (RFC E §4.1). Holds
 * only the page-0 payload for each `(agent, parent_id?)` key — that's
 * what the picker hits on every fresh open. Subsequent pagination is
 * uncached because the user is actively navigating and wants fresh
 * data.
 *
 * The `[ ↻ Refresh ]` button bypasses cache via `forceRefresh: true`.
 */
export class FolderListCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { expires_at: number; page: FolderPage }>();

  constructor(opts?: { ttl_ms?: number; now?: () => number }) {
    this.ttlMs = opts?.ttl_ms ?? 5 * 60 * 1000;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * Return the cached first page for `(agent, parent_id?)`, or `null`
   * on a miss / expiry. Cache is keyed on the parent so the picker
   * can navigate `/Work/2026/Q3` and have each level's first page
   * cached independently.
   */
  get(agent: string, parent_id?: string): FolderPage | null {
    const key = cacheKey(agent, parent_id);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expires_at <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.page;
  }

  /** Write the first page for `(agent, parent_id?)`. */
  set(agent: string, page: FolderPage, parent_id?: string): void {
    const key = cacheKey(agent, parent_id);
    this.entries.set(key, {
      expires_at: this.now() + this.ttlMs,
      page,
    });
  }

  /** Drop all entries for an agent — used when the agent disconnects. */
  invalidateAgent(agent: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key === agent || key.startsWith(`${agent}|`)) {
        this.entries.delete(key);
      }
    }
  }

  /** Drop everything — used by tests. */
  clear(): void {
    this.entries.clear();
  }

  /** Exposed for tests. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Convenience: get-or-fetch first page for `(agent, parent_id?)` with
 * the standard `[ ↻ Refresh ]` semantics. Single-flight is not
 * attempted — concurrent first-opens just both refresh; the cost is
 * a duplicate API call, not a correctness bug.
 */
export async function getOrFetchFirstPage(args: {
  agent: string;
  cache: FolderListCache;
  access_token: string;
  parent_id?: string;
  force_refresh?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<FolderPage> {
  if (!args.force_refresh) {
    const hit = args.cache.get(args.agent, args.parent_id);
    if (hit !== null) return hit;
  }
  const fetched = await fetchFolderPage({
    access_token: args.access_token,
    parent_id: args.parent_id,
    fetchImpl: args.fetchImpl,
  });
  args.cache.set(args.agent, fetched, args.parent_id);
  return fetched;
}

function cacheKey(agent: string, parent_id?: string): string {
  // `|` is not legal in agent names (alnum + - + _ only) or Drive ids
  // (URL-safe base64), so it can't appear in either component — no
  // collision risk between an agent named `foo` browsing parent `bar`
  // and an agent named `foo|bar` at top level (both impossible inputs
  // either way; defense in depth).
  return parent_id === undefined ? agent : `${agent}|${parent_id}`;
}
