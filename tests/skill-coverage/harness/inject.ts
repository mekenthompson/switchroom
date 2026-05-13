/**
 * NDJSON `inject_inbound` writer for the harness runner.
 *
 * Mirrors `src/agent-scheduler/ipc-client.ts` — the same socket
 * protocol the in-agent scheduler uses to inject synthesized turns
 * into the gateway. We don't need reconnect/replay semantics here
 * because the harness is short-lived; on the first connect failure
 * we just bail and let the runner report the probe as `timedOut`.
 */

import { createConnection, type Socket } from "node:net";
import type {
  InboundMessage,
  InjectInboundMessage,
} from "../../../telegram-plugin/gateway/ipc-protocol.js";

let _injectCounter = 0;
function injectCounter(): number {
  _injectCounter = (_injectCounter + 1) & 0xffff;
  return _injectCounter;
}

export interface InjectOptions {
  socketPath: string;
  agentName: string;
  text: string;
  /** Telegram chat id to claim — defaults to a deterministic harness id. */
  chatId?: string;
  /** Useful when the harness wants to thread its probes per skill. */
  threadId?: number;
  /** Defaults to 5000ms. */
  connectTimeoutMs?: number;
  /**
   * Test seam — fakes pass an alternative connect to avoid touching
   * the kernel socket layer in unit tests.
   */
  _connect?: (socketPath: string) => Socket;
}

export interface InjectOutcome {
  injectedAt: string;
  inboundId: string;
  /** True if the bytes were accepted by the local socket. */
  written: boolean;
  /** Set only on failure paths. */
  error?: string;
}

/**
 * Connect to the gateway socket, write a single `inject_inbound`
 * envelope, and end the connection. Returns once the OS has accepted
 * the bytes — the runner's observe loop is what actually proves the
 * turn ran.
 */
export function injectInbound(opts: InjectOptions): Promise<InjectOutcome> {
  const {
    socketPath,
    agentName,
    text,
    chatId = "-1001000000000",
    threadId,
    connectTimeoutMs = 5_000,
    _connect = (p) => createConnection(p),
  } = opts;

  const injectedAt = new Date().toISOString();
  // messageId: ms timestamp + 16-bit process-local counter, masked to a
  // positive int32. Two probes inside the same ms get distinct ids
  // (gateway treats duplicates as replays).
  const ts = Date.now();
  const messageId = ((ts & 0x7fff) << 16) | (injectCounter() & 0xffff);
  const inbound: InboundMessage = {
    type: "inbound",
    chatId,
    threadId,
    messageId,
    user: "skill-coverage-harness",
    userId: 0,
    ts,
    text,
    meta: {
      source: "skill-coverage-harness",
      injectedAt,
    },
  };
  const envelope: InjectInboundMessage = {
    type: "inject_inbound",
    agentName,
    inbound,
  };

  return new Promise<InjectOutcome>((resolve) => {
    let settled = false;
    let socket: Socket;
    try {
      socket = _connect(socketPath);
    } catch (err) {
      resolve({
        injectedAt,
        inboundId: String(messageId),
        written: false,
        error: (err as Error).message,
      });
      return;
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({
        injectedAt,
        inboundId: String(messageId),
        written: false,
        error: `connect timeout after ${connectTimeoutMs}ms`,
      });
    }, connectTimeoutMs);

    socket.on("connect", () => {
      try {
        const ok = socket.write(JSON.stringify(envelope) + "\n", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try { socket.end(); } catch { /* ignore */ }
          if (err) {
            resolve({
              injectedAt,
              inboundId: String(messageId),
              written: false,
              error: err.message,
            });
          } else {
            resolve({
              injectedAt,
              inboundId: String(messageId),
              written: true,
            });
          }
        });
        if (!ok) {
          // Backpressure — fall through, the write callback above will
          // resolve us when drain completes.
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          injectedAt,
          inboundId: String(messageId),
          written: false,
          error: (err as Error).message,
        });
      }
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        injectedAt,
        inboundId: String(messageId),
        written: false,
        error: err.message,
      });
    });
  });
}
