/**
 * switchroom-hostd client — a thin wrapper over the per-agent UDS
 * connection. Single-shot: opens, writes one framed request, reads
 * one framed response, closes.
 *
 * Phase 1 callers: the gateway integration (Phase 2 PR), and tests.
 * Phase 1 deliberately does NOT swap any gateway callsites — that
 * requires careful threading of restart-marker / sweep / fallback
 * logic the existing `spawnSwitchroomDetached` path already handles,
 * and is sized for its own PR.
 */

import { connect, type Socket } from "node:net";
import {
  encodeRequest,
  decodeResponse,
  type HostdRequest,
  type HostdResponse,
  MAX_FRAME_BYTES,
} from "./protocol.js";

export interface ClientOptions {
  /** Path to the UDS socket. In an agent container this is
   *  `/run/switchroom/hostd/<self>/sock`. */
  socketPath: string;
  /** Connection + response timeout (ms). Default: 5000. */
  timeoutMs?: number;
}

/**
 * Send one request and receive one response. The connection is
 * single-shot — opened per call, closed by the server after the
 * response. Throws on connection failure, timeout, or frame
 * decode error (with the original error chained as `cause`).
 */
export async function hostdRequest(
  opts: ClientOptions,
  req: HostdRequest,
): Promise<HostdResponse> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(opts.socketPath);
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`hostd: request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("connect", () => {
      try {
        socket.write(encodeRequest(req));
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (Buffer.byteLength(buf, "utf8") > MAX_FRAME_BYTES * 2) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("hostd: response exceeded frame budget"));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        const resp = decodeResponse(line);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.end();
        resolve(resp);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(
          new Error(
            `hostd: bad response frame: ${(err as Error).message}`,
            { cause: err },
          ),
        );
      }
    });
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("hostd: connection closed before response"));
    });
  });
}
