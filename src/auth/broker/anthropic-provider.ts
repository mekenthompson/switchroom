/**
 * AnthropicProvider — Provider implementation for Anthropic OAuth
 * (RFC G Phase 3b.1b).
 *
 * **Honest scope note:** the broker continues to do Anthropic refresh
 * via `src/auth/account-refresh.ts:refreshAccountIfNeeded` directly,
 * not through this provider's `refresh()` method. The reason: Anthropic's
 * refresh has been load-bearing through RFC H's review and is tightly
 * coupled with the broker's storage layer (writes credentials.json
 * verbatim to `~/.switchroom/accounts/<label>/`). Routing it through a
 * provider abstraction without changing semantics adds indirection
 * without value.
 *
 * What this provider DOES contribute today:
 *   - **`extractExpiresAt`** — broker uses this for threshold-based
 *     refresh decisions, currently calling it through the provider
 *     interface so the same code path works when Phase 3b.2 plugs
 *     Google in.
 *   - **`validateCredentialShape`** — used at `add-account` time. The
 *     server-side cross-check (provider field matches credentials
 *     variant) calls this through the provider interface.
 *   - **Registry presence** — `registry.has("anthropic")` gates the
 *     provider field on incoming requests. Without registering this,
 *     the broker would reject `provider: "anthropic"` requests as
 *     unknown-provider.
 *
 * Phase 3b.2 (Google provider) implements `refresh()` for real because
 * Google has its own HTTP endpoint, request/response shape, and error
 * mapping — separate machinery from Anthropic's `account-refresh.ts`.
 * The broker dispatches refresh ops through the registry for Google
 * accounts; for Anthropic accounts it continues to short-circuit to
 * the existing direct call.
 *
 * This split is honest: two providers, two refresh paths today, one
 * shared schema-validation + expiry-extraction surface.
 */

import type { Provider, RefreshRequest, RefreshResult } from "./provider.js";
import type { AnthropicCredentialsShape } from "./protocol.js";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;

  /**
   * Anthropic's refresh exchange lives in `src/auth/account-refresh.ts`
   * and is invoked directly by the broker (not through this provider).
   * See class docstring for rationale. This method exists to satisfy
   * the Provider interface but the broker doesn't currently call it
   * for Anthropic accounts — calling it returns a clear "use the
   * direct path" error.
   */
  async refresh(_req: RefreshRequest): Promise<RefreshResult> {
    return {
      ok: false,
      kind: "provider_error",
      detail:
        "AnthropicProvider.refresh is not the broker's refresh path for Anthropic accounts; broker calls account-refresh.ts:refreshAccountIfNeeded directly. See provider docstring.",
    };
  }

  /**
   * Anthropic credentials carry expiry under `claudeAiOauth.expiresAt`.
   * Used by the broker's threshold-based refresh tick.
   */
  extractExpiresAt(credentials: unknown): number | undefined {
    const c = credentials as AnthropicCredentialsShape | null | undefined;
    return c?.claudeAiOauth?.expiresAt;
  }

  /**
   * Validate the on-disk shape Anthropic credentials must conform to.
   * Returns null on success; an actionable error string on failure.
   * Called by the server's `add-account` handler before storage.
   */
  validateCredentialShape(credentials: unknown): string | null {
    if (!credentials || typeof credentials !== "object") {
      return "Anthropic credentials must be an object";
    }
    const c = credentials as { claudeAiOauth?: unknown };
    if (!c.claudeAiOauth || typeof c.claudeAiOauth !== "object") {
      return "Anthropic credentials must have a claudeAiOauth object";
    }
    const oauth = c.claudeAiOauth as { accessToken?: unknown };
    if (typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      return "Anthropic claudeAiOauth.accessToken must be a non-empty string";
    }
    return null;
  }
}
