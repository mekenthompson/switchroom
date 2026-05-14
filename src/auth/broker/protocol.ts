/**
 * auth-broker wire protocol — newline-delimited JSON (NDJSON).
 *
 * Mirrors `src/vault/broker/protocol.ts` framing: one JSON object
 * per line, terminated by "\n", request/response per connection
 * turn, connection persists for multiple sequential requests.
 *
 * Path-as-identity is the auth model — the broker derives the
 * calling agent or consumer from the bind path the connection
 * arrived on (`/run/switchroom/auth-broker/<name>/sock`), never
 * from a wire payload. No verb takes an `agent:` or `caller:`
 * argument.
 *
 * Eight verbs in v1 (RFC H §4.3):
 *
 *   - `get-credentials` — return the caller's current credentials.
 *   - `list-state`      — fleet snapshot (accounts, agents, consumers).
 *   - `set-active`      — fleet-wide active-account swap (admin).
 *   - `mark-exhausted`  — quota event on caller's bound account.
 *   - `refresh-account` — force a refresh tick (admin).
 *   - `add-account`     — register a new account (admin).
 *   - `rm-account`      — remove an account (admin).
 *   - `set-override`    — per-agent override (admin).
 *
 * `mark-exhausted` takes ONLY an `until` argument; the account it
 * affects is derived from path-identity. This closes the
 * fleet-wide spurious-deauth abuse path the round-1 review
 * flagged.
 *
 * **Provider field (RFC G Phase 3b.1):** Per-account verbs accept an
 * optional `provider:` field. When absent or `"anthropic"`, behavior
 * is unchanged from RFC H. When `"google"` (added by Phase 3b.2),
 * the broker dispatches through the Google provider. Per-account
 * state is keyed on `(provider, account)` so an account named
 * `"alice@example.com"` registered as Google does not collide with
 * an Anthropic account label of the same string.
 *
 * `get-credentials` and `mark-exhausted` derive provider+account
 * from path-identity (the broker knows which provider an agent or
 * consumer is bound to from its socket-mount config), so they don't
 * take a `provider:` field on the wire.
 */

import { z } from "zod";
import type { AccountCredentials } from "../account-store.js";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Hard cap on one frame. Credentials JSON is small; this is plenty. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** Wire-protocol major version. Bump on breaking change to envelope shape. */
export const PROTOCOL_VERSION = 1;

/**
 * Provider names accepted on the wire (RFC G Phase 3b.1). New providers
 * extend this enum; the broker server validates incoming `provider:`
 * fields against it before dispatching.
 */
export const ProviderNameSchema = z.enum(["anthropic", "google"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/**
 * Default provider — `"anthropic"`. Used when verbs omit the
 * `provider:` field entirely (back-compat with RFC H pre-Phase-3b
 * clients).
 */
export const DEFAULT_PROVIDER: ProviderName = "anthropic";

// ─── Request schemas ───────────────────────────────────────────────────────

export const GetCredentialsRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("get-credentials"),
  id: z.string().min(1),
});

export const ListStateRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("list-state"),
  id: z.string().min(1),
});

export const SetActiveRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("set-active"),
  id: z.string().min(1),
  account: z.string().min(1),
  /**
   * Provider for the target account. Optional, defaults to
   * `"anthropic"` (back-compat with RFC H pre-Phase-3b clients).
   * `set-active` is fleet-wide active-account swap which is currently
   * an Anthropic-only concept; Google's account-active model is
   * per-agent-via-`google_accounts.enabled_for[]`. This field is
   * carried for protocol uniformity even though `set-active` will
   * reject `provider: "google"` until/unless a fleet-wide-active
   * Google concept is added.
   */
  provider: ProviderNameSchema.optional(),
});

export const MarkExhaustedRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("mark-exhausted"),
  id: z.string().min(1),
  /** Unix ms when the exhaustion clears. Defaults to now + 5h if omitted. */
  until: z.number().int().positive().optional(),
});

export const RefreshAccountRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("refresh-account"),
  id: z.string().min(1),
  account: z.string().min(1),
  /** Provider for the target account. Defaults to `"anthropic"` for back-compat. */
  provider: ProviderNameSchema.optional(),
});

/**
 * Anthropic-shaped credentials — the Phase-1 (RFC H) shape. Stored
 * verbatim under `claudeAiOauth: { ... }`.
 */
export const AnthropicCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().optional(),
    rateLimitTier: z.string().optional(),
  }),
});
export type AnthropicCredentialsShape = z.infer<typeof AnthropicCredentialsSchema>;

/**
 * Google-shaped credentials — added by Phase 3b.2. Stored verbatim
 * under `googleOauth: { ... }`. Field set mirrors what
 * `taylorwilsdon/google_workspace_mcp` and the Google OAuth 2.0
 * token-exchange response provide.
 */
export const GoogleCredentialsSchema = z.object({
  googleOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    /** Granted scope set, space-separated as Google returns it. */
    scope: z.string(),
    /** OAuth client id used to obtain the credentials (broker validates on refresh). */
    clientId: z.string(),
    /** Account email — RFC G's per-account ACL key. */
    accountEmail: z.string(),
    tokenType: z.literal("Bearer"),
  }),
});
export type GoogleCredentialsShape = z.infer<typeof GoogleCredentialsSchema>;

/**
 * Provider-discriminated credentials union. Each variant is the
 * verbatim on-disk shape for that provider. Broker stores credentials
 * pass-through; consumers (CLI, MCP wrapper) introspect.
 */
export const ProviderCredentialsSchema = z.union([
  AnthropicCredentialsSchema,
  GoogleCredentialsSchema,
]);
export type ProviderCredentialsShape = z.infer<typeof ProviderCredentialsSchema>;

export const AddAccountRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("add-account"),
  id: z.string().min(1),
  label: z.string().min(1),
  /**
   * Provider for the new account. Defaults to `"anthropic"` for
   * back-compat — RFC H pre-Phase-3b clients omit this field and
   * pass Anthropic credentials.
   *
   * The provider field MUST agree with the credentials shape:
   * `provider: "anthropic"` requires `claudeAiOauth: { ... }`,
   * `provider: "google"` requires `googleOauth: { ... }`. Server
   * validates this agreement and rejects with INVALID_ARGS otherwise.
   */
  provider: ProviderNameSchema.optional(),
  /**
   * Full credentials.json shape for the provider; broker stores verbatim.
   * Schema is a union over provider variants — the server validates the
   * variant matches `provider:` (or `DEFAULT_PROVIDER`).
   */
  credentials: ProviderCredentialsSchema,
  /** Replace an existing account (used for drift recovery). */
  replace: z.boolean().optional(),
});

export const RmAccountRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("rm-account"),
  id: z.string().min(1),
  label: z.string().min(1),
  /** Provider for the account. Defaults to `"anthropic"` for back-compat. */
  provider: ProviderNameSchema.optional(),
});

export const SetOverrideRequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  op: z.literal("set-override"),
  id: z.string().min(1),
  agent: z.string().min(1),
  /** null clears the override (agent returns to fleet active). */
  account: z.string().min(1).nullable(),
});

export const RequestSchema = z.discriminatedUnion("op", [
  GetCredentialsRequestSchema,
  ListStateRequestSchema,
  SetActiveRequestSchema,
  MarkExhaustedRequestSchema,
  RefreshAccountRequestSchema,
  AddAccountRequestSchema,
  RmAccountRequestSchema,
  SetOverrideRequestSchema,
]);

export type Request = z.infer<typeof RequestSchema>;

// ─── Response data shapes ──────────────────────────────────────────────────

export const GetCredentialsDataSchema = z.object({
  account: z.string(),
  credentials: z.unknown(), // AccountCredentials, passed through verbatim
  expiresAt: z.number().optional(),
});

export const AccountStateSchema = z.object({
  label: z.string(),
  expiresAt: z.number().optional(),
  exhausted: z.boolean(),
  exhausted_until: z.number().optional(),
  threshold_violations: z.number().int().nonnegative().optional(),
  last_refreshed_at: z.number().optional(),
});

export const AgentStateSchema = z.object({
  name: z.string(),
  account: z.string(),
  override: z.string().nullable(),
});

export const ConsumerStateSchema = z.object({
  name: z.string(),
  account: z.string(),
  last_seen_at: z.number().nullable(),
});

export const ListStateDataSchema = z.object({
  active: z.string(),
  fallback_order: z.array(z.string()),
  accounts: z.array(AccountStateSchema),
  agents: z.array(AgentStateSchema),
  consumers: z.array(ConsumerStateSchema),
});

export const SetActiveDataSchema = z.object({
  active: z.string(),
  fanned: z.array(z.string()),
});

export const MarkExhaustedDataSchema = z.object({
  account: z.string(),
  rolled: z.array(z.string()),
});

export const RefreshAccountDataSchema = z.object({
  account: z.string(),
  expiresAt: z.number().optional(),
});

export const AddAccountDataSchema = z.object({
  label: z.string(),
  expiresAt: z.number().optional(),
});

export const RmAccountDataSchema = z.object({
  label: z.string(),
});

export const SetOverrideDataSchema = z.object({
  agent: z.string(),
  account: z.string().nullable(),
});

// ─── Response envelope ─────────────────────────────────────────────────────

export const ErrorBodySchema = z.object({
  code: z.enum([
    "FORBIDDEN",
    "INVALID_ARGS",
    "UNKNOWN_VERB",
    "VERSION_MISMATCH",
    "ACCOUNT_NOT_FOUND",
    "ACCOUNT_ALREADY_EXISTS",
    "CONFIG_INVALID",
    "DRIFT_DETECTED",
    "REFRESH_FAILED",
    "INTERNAL",
  ]),
  message: z.string(),
});
export type ErrorCode = z.infer<typeof ErrorBodySchema>["code"];

export const SuccessResponseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
});

export const ErrorResponseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  ok: z.literal(false),
  error: ErrorBodySchema,
});

export const ResponseSchema = z.discriminatedUnion("ok", [
  SuccessResponseSchema,
  ErrorResponseSchema,
]);

export type Response = z.infer<typeof ResponseSchema>;

// ─── Encode / decode helpers ───────────────────────────────────────────────

/**
 * Encode a request as a single NDJSON frame (trailing newline included).
 * Throws when the serialized frame would exceed MAX_FRAME_BYTES.
 */
export function encodeRequest(req: Request): string {
  const line = JSON.stringify(RequestSchema.parse(req)) + "\n";
  if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
    throw new Error(
      `auth-broker request exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  return line;
}

export function decodeRequest(line: string): Request {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("auth-broker request is not valid JSON");
  }
  return RequestSchema.parse(parsed);
}

/**
 * Build a success response. `data` is unknown by design — the server
 * embeds a per-verb shape (see `*DataSchema` above) but the envelope
 * itself stays untyped.
 */
export function encodeSuccess(id: string, data: unknown): string {
  const line = JSON.stringify({ v: PROTOCOL_VERSION, id, ok: true, data }) + "\n";
  if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
    throw new Error(
      `auth-broker response exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  return line;
}

export function encodeError(id: string, code: ErrorCode, message: string): string {
  return (
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message },
    }) + "\n"
  );
}

export function decodeResponse(line: string): Response {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("auth-broker response is not valid JSON");
  }
  return ResponseSchema.parse(parsed);
}

/** Re-export the credentials shape so clients depend on the protocol module only. */
export type { AccountCredentials };
