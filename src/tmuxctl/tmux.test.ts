import { describe, test, expect } from "bun:test";
import { Session } from "./tmux";

describe("tmuxctl", () => {
  test("new session + capture", async () => {
    const sess = await Session.newSession("allagent-test", 80, 24, "/tmp", [
      "bash",
      "-c",
      "echo ALLAGENT_OK; sleep 3",
    ]);
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
    const sess = await Session.newSession("allagent-send-test", 80, 24, "/tmp", [
      "bash",
    ]);
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
