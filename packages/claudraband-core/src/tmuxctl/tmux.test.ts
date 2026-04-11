import { describe, test, expect } from "bun:test";
import { Session } from "./tmux";

function isSandboxTmuxError(err: unknown): boolean {
  return String(err).includes("Operation not permitted");
}

describe("tmuxctl", () => {
  test("new session + capture", async () => {
    let sess: Session;
    try {
      sess = await Session.newSession("claudraband-test", 80, 24, "/tmp", [
        "bash",
        "-c",
        "echo ALLAGENT_OK; sleep 3",
      ]);
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(500);
      expect(sess.isAlive).toBe(true);

      const out = await sess.capturePane();
      expect(out).toContain("ALLAGENT_OK");
    } finally {
      await sess.kill();
    }
  });

  test("send line", async () => {
    let sess: Session;
    try {
      sess = await Session.newSession("claudraband-send-test", 80, 24, "/tmp", [
        "bash",
      ]);
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(300);

      await sess.sendLine("echo SEND_TEST_OK");
      await Bun.sleep(500);

      const out = await sess.capturePane();
      expect(out).toContain("SEND_TEST_OK");
    } finally {
      await sess.kill();
    }
  });
});
