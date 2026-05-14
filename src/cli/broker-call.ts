/**
 * Shared auth-broker call wrapper for CLI verbs.
 *
 * Centralizes the broker-error handling shape so every CLI verb that
 * touches the broker (auth account commands, auth google account
 * commands per RFC G Phase 3b.3, future per-vendor commands) gets
 * identical error UX:
 *
 *   - Operator-actionable "broker unreachable" message with a
 *     `docker compose ps` hint, exit code 2
 *   - Broker error code + message printed to stderr, exit code 1
 *   - Other errors re-thrown for the surrounding withConfigError
 *     wrapper to catch
 *
 * Extracted from `src/cli/auth.ts` (where these helpers originally
 * lived as private functions) into a shared module per RFC G Phase
 * 3b.3 review feedback. The functions here are byte-for-byte the
 * Anthropic-side originals — same exit codes, same messages, same
 * stderr-not-stdout discipline.
 */

import chalk from "chalk";

import {
  AuthBrokerClient,
  AuthBrokerError,
  AuthBrokerUnreachableError,
  withAuthBrokerClient,
} from "../auth/broker/client.js";

/**
 * Print operator-actionable error and exit 2 when the broker socket
 * isn't reachable. Hint points at the daemon container so the
 * operator knows where to look.
 */
export function dieBrokerUnreachable(err: AuthBrokerUnreachableError): never {
  console.error(chalk.red(`  auth-broker unreachable: ${err.message}`));
  console.error(
    chalk.gray(
      `  Check the daemon: docker compose -p switchroom ps switchroom-auth-broker`,
    ),
  );
  process.exit(2);
}

/**
 * Print broker's error code + message to stderr and exit 1. Surfaces
 * the broker's discriminant (`INVALID_ARGS`, `FORBIDDEN`, etc.) so
 * scripts can branch on it. Plain message, no decoration — broker
 * messages are operator-actionable by contract.
 */
export function dieBrokerError(err: AuthBrokerError): never {
  console.error(chalk.red(`  ${err.code}: ${err.message}`));
  process.exit(1);
}

/**
 * Run a broker-touching CLI action. Wraps the connection lifecycle
 * (connect → send → close) and routes the two broker-specific error
 * classes through the appropriate die-handler. Other errors propagate
 * for the caller's `withConfigError` wrapper to format.
 */
export async function brokerCall<T>(
  fn: (client: AuthBrokerClient) => Promise<T>,
): Promise<T> {
  try {
    return await withAuthBrokerClient(fn);
  } catch (err) {
    if (err instanceof AuthBrokerUnreachableError) dieBrokerUnreachable(err);
    if (err instanceof AuthBrokerError) dieBrokerError(err);
    throw err;
  }
}
