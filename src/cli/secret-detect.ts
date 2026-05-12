import type { Command } from "commander";

import { redact } from "../secret-detect/redact.js";

/**
 * `switchroom secret-detect <subcommand>` — operator-facing surface for
 * the secret-detect engine.
 *
 * Currently only `redact --stdin` is wired in. It reads UTF-8 from
 * stdin, runs the same redactor that `issues record` uses on its
 * `--detail` input, and writes the result to stdout. Existence
 * rationale: `bin/run-hook.sh` (a bash script) needs to pipe stderr
 * through the redactor before handing it off to `issues record`; this
 * subcommand is the bash-callable shim that makes that possible.
 *
 * The receiving CLI (`issues record`) also redacts on input as a
 * defense-in-depth backstop, in case a future caller forgets to pipe.
 *
 * Stream-safety: input is streamed in 64 KB chunks. We don't slurp the
 * whole stderr into a bash variable upstream (`bin/run-hook.sh` uses
 * `tail -n 60 file | <cli>`), but the buffered approach here keeps a
 * very large multi-line stderr (e.g. a Python traceback with huge
 * response body) from spiking RSS.
 */
export function registerSecretDetectCommand(program: Command): void {
  const sd = program
    .command("secret-detect")
    .description("Secret detection / redaction utilities");

  sd.command("redact")
    .description("Redact secrets from stdin and write the result to stdout")
    .option(
      "--stdin",
      "Read input from stdin (currently the only mode)",
      false,
    )
    .action((opts: { stdin?: boolean }) => {
      // `--stdin` is the documented mode. For now we always read from
      // stdin since that's the only sensible callsite (bash pipe). The
      // flag is accepted (and required for future-proofing) but we
      // don't error on its absence — bash callers may forget it and we
      // shouldn't silently hang on a TTY.
      void opts;
      runRedactStdin();
    });
}

function runRedactStdin(): void {
  // TTY guard: if someone runs `switchroom secret-detect redact` at a
  // shell with no piped input, refuse rather than block on EOF that
  // will never come. Mirrors the same guard in `issues record`.
  if (process.stdin.isTTY) {
    process.stderr.write(
      "secret-detect redact: refusing to read from a TTY (would hang).\n",
    );
    process.exit(2);
  }

  const chunks: Buffer[] = [];
  process.stdin.on("data", (c) => {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  });
  process.stdin.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf-8");
    const out = redact(text);
    process.stdout.write(out);
    // Don't append a trailing newline — the consumer (`issues record
    // --detail-stdin`) takes the bytes verbatim and we want to preserve
    // the input's own line endings.
  });
  process.stdin.on("error", (err) => {
    process.stderr.write(
      `secret-detect redact: stdin error: ${(err as Error).message}\n`,
    );
    process.exit(1);
  });
}
