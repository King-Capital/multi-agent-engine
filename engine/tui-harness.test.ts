import { describe, expect, test } from "bun:test";
import { startTuiSession, tmuxAvailable } from "./tui-harness";

const runTmuxTests = process.env.MAE_RUN_TMUX_TESTS === "1";

describe("tmux TUI harness", () => {
  test("reports whether tmux is available", async () => {
    expect(typeof await tmuxAvailable()).toBe("boolean");
  });

  (runTmuxTests ? test : test.skip)("captures the MAE TUI entrypoint in a tmux session", async () => {
    const session = await startTuiSession("bun engine/cli.ts tui --help; sleep 2", { width: 100, height: 30, waitMs: 500 });
    try {
      const screen = await session.capture();
      expect(screen).toContain("mae tui");
      expect(screen).toContain("Full interactive launcher");
    } finally {
      await session.stop();
    }
  }, 10_000);
});
