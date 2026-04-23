/**
 * URL redactor — strip credentials and mask sensitive query params in place.
 *
 * Port of the openclaw `redact-sensitive-url` pattern. The goal isn't to
 * *detect* a secret (that's what patterns.ts does) but to scrub URLs embedded
 * in chat text before they're logged, echoed to the model, or stored in
 * history. If a user pastes
 *     https://u:p@api.example.com/x?api_key=abc123&trace=42
 * the rewritten text becomes
 *     https://***@api.example.com/x?api_key=***&trace=42
 *
 * Only string-level transformation — no network, no parsing beyond WHATWG URL.
 */
const SENSITIVE_PARAMS = new Set([
  'token',
  'key',
  'api_key',
  'apikey',
  'secret',
  'access_token',
  'password',
  'pass',
  'auth',
  'client_secret',
  'refresh_token',
  'signature',
])

// Loose URL regex — covers http(s)/ws(s)/ftp schemes. Intentionally permissive
// on the tail; WHATWG URL parsing is what actually rejects garbage.
const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s<>"']+/gi

export function redactUrls(text: string): string {
  return text.replace(URL_RE, (m) => {
    const redacted = redactOne(m)
    return redacted ?? m
  })
}

function redactOne(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  let changed = false
  if (u.username || u.password) {
    u.username = '***'
    u.password = ''
    changed = true
  }
  for (const [key] of u.searchParams) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
      u.searchParams.set(key, '***')
      changed = true
    }
  }
  return changed ? u.toString() : null
}
