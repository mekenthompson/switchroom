/**
 * `switchroom init` — deprecation shim.
 *
 * Renamed to `apply` in v0.7. This file now re-exports the shim from
 * `deprecated.ts` so the name still resolves for any external import,
 * but registration in `index.ts` goes through `deprecated.ts` directly.
 * Slated for removal in v0.8.
 */
export { registerInitCommand } from "./deprecated.js";
