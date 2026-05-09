/**
 * Scenario harness for UAT runs.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 *
 * `spinUp({ agent, topic })` is the single entry point a scenario
 * uses. Phase 1 ships the type shape + the lifecycle skeleton; the
 * actual `child_process.spawn` of the agent under test is stubbed
 * with TODO markers so the reviewer can see exactly where Phase 2
 * lands.
 */

import { Driver } from "./driver.js";
import {
  expectMessage,
  expectPinnedCard,
  expectReaction,
  waitForCardPhase,
  type PollOptions,
  type PinnedCardSnapshot,
} from "./assertions.js";
import { allocatePort } from "./port-allocator.js";

export interface SpinUpOptions {
  /** Agent name to install + run, e.g. `"clerk"`, `"test-harness"`. */
  agent: string;
  /**
   * Forum topic slug for isolation. The harness creates the topic in
   * the test supergroup and tears it down after the scenario.
   */
  topic: string;
}

export interface Scenario {
  /** mtcute driver, already connected. */
  driver: Driver;
  /** Negative supergroup chat id; from `$SWITCHROOM_UAT_CHAT_ID`. */
  chatId: number;
  /** Topic id created for this scenario. */
  threadId: number;

  // Sugar over the assertion helpers, pre-bound to this scenario's
  // chat + thread. Phase 1 returns a thin pass-through.
  expectMessage: (
    match: Parameters<typeof expectMessage>[2],
    opts: PollOptions & { from?: "bot" | "user" },
  ) => ReturnType<typeof expectMessage>;
  expectReaction: (
    messageId: number,
    sequence: string[],
    opts: PollOptions,
  ) => ReturnType<typeof expectReaction>;
  expectPinnedCard: (opts: PollOptions) => ReturnType<typeof expectPinnedCard>;
  waitForCardPhase: (
    card: PinnedCardSnapshot,
    phase: "boot" | "working" | "done" | "error",
    opts: PollOptions,
  ) => ReturnType<typeof waitForCardPhase>;

  /** Stop the agent process, delete the topic, disconnect the driver. */
  tearDown: () => Promise<void>;
}

/**
 * Spin up an isolated agent + scenario context.
 *
 * Phase 1: returns a stub Scenario whose tools throw helpful "not
 * implemented" errors. The shape is correct so scenarios written
 * against it will typecheck today and run for real once Phase 2
 * lands.
 */
export async function spinUp(opts: SpinUpOptions): Promise<Scenario> {
  // TODO(#866): resolve secrets from vault.
  //   - `telegram-test-bot-token` for the agent under test
  //   - `telegram-uat-driver-session` for the mtcute driver
  //   - `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from env
  // For now we throw early with a clear message so accidental runs
  // before Phase 2 don't crash with confusing stack traces.
  if (!process.env.SWITCHROOM_UAT_CHAT_ID) {
    throw new Error(
      "[uat/harness] SWITCHROOM_UAT_CHAT_ID is not set — see uat/SETUP.md §2",
    );
  }
  const chatId = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID, 10);
  if (!Number.isFinite(chatId) || chatId >= 0) {
    throw new Error(
      `[uat/harness] SWITCHROOM_UAT_CHAT_ID must be a negative supergroup id (got ${process.env.SWITCHROOM_UAT_CHAT_ID})`,
    );
  }

  // TODO(#866): allocate gateway port + ephemeral STATE_DIR.
  //   const port = await allocatePort();
  //   const stateDir = await mkdtemp(join(tmpdir(), `uat-${opts.agent}-`));
  //   process.env.STATE_DIR is per-process — we instead pass STATE_DIR
  //   in the spawned child's env, never mutate ours.
  const port = await allocatePort();
  void port; // Phase 2: feed into agent child env

  // TODO(#866): create the forum topic via Bot API
  // (`createForumTopic`) using the test bot token; capture the
  // returned `message_thread_id` and stash for tearDown's
  // `deleteForumTopic`.
  const threadId = -1; // sentinel; Phase 2 fills in

  // TODO(#866): spawn the agent under test as a child process.
  //   const child = spawn(process.execPath, [agentEntry], {
  //     env: {
  //       ...process.env,
  //       STATE_DIR: stateDir,
  //       TELEGRAM_GATEWAY_PORT: String(port),
  //       SWITCHROOM_AGENT_NAME: opts.agent,
  //       BOT_TOKEN: <vault: telegram-test-bot-token>,
  //     },
  //     stdio: ["ignore", "pipe", "pipe"],
  //   });
  //   await waitForGatewayReady(port, { timeout: 30_000 });

  // TODO(#866): connect mtcute driver.
  //   const driver = new Driver({ apiId, apiHash, session });
  //   await driver.connect();
  const driver = new Driver({
    apiId: 0,
    apiHash: "",
    session: "<resolved-from-vault>",
  });

  const scenario: Scenario = {
    driver,
    chatId,
    threadId,
    expectMessage: (match, pollOpts) =>
      expectMessage(driver, chatId, match, {
        ...pollOpts,
        threadId,
      }),
    expectReaction: (messageId, sequence, pollOpts) =>
      expectReaction(driver, chatId, messageId, sequence, pollOpts),
    expectPinnedCard: (pollOpts) =>
      expectPinnedCard(driver, chatId, { ...pollOpts, threadId }),
    waitForCardPhase: (card, phase, pollOpts) =>
      waitForCardPhase(driver, card, phase, pollOpts),
    tearDown: async () => {
      // TODO(#866): SIGTERM child, await exit (or SIGKILL after 5s),
      // delete forum topic, rm -rf state dir, disconnect driver.
      await driver.disconnect().catch(() => {
        /* idempotent */
      });
    },
  };

  // Phase 1 marker so accidental runs fail loudly instead of silently
  // sending nothing.
  void opts;
  throw new Error(
    "[uat/harness] spinUp is scaffolded but not wired (Phase 1 stub) — see TODO markers in uat/harness.ts",
  );

  // unreachable in Phase 1; left for shape:
  // eslint-disable-next-line no-unreachable
  return scenario;
}
