import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Session, hasSession, killSession } from "./tmux";

function isSandboxTmuxError(err: unknown): boolean {
  return String(err).includes("Operation not permitted");
}

function sharedSessionName(): string {
  return `claudraband-test-${randomUUID()}`;
}

function listWindows(name: string): string[] {
  const result = spawnSync("tmux", ["list-windows", "-t", name, "-F", "#{window_name}"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to list windows for ${name}`);
  }
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1500,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe("tmuxctl", () => {
  test("creates the first Claude window in a new shared session", async () => {
    const name = sharedSessionName();
    let sess: Session | undefined;
    try {
      sess = await Session.newSession(name, 80, 24, "/tmp", [
        "bash",
        "-c",
        "echo ALLAGENT_OK; sleep 3",
      ], "claude-session-1");
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(500);
      expect(sess.isAlive).toBe(true);
      expect(hasSession(name)).toBe(true);
      expect(listWindows(name)).toEqual(["claude-session-1"]);
      expect(await sess.capturePane()).toContain("ALLAGENT_OK");
    } finally {
      await sess?.kill().catch(() => {});
      await killSession(name).catch(() => {});
    }
  });

  test("creates a new window when the shared tmux session already exists", async () => {
    const name = sharedSessionName();
    let first: Session | undefined;
    let second: Session | undefined;
    try {
      first = await Session.newSession(name, 80, 24, "/tmp", [
        "bash",
        "-c",
        "echo FIRST_OK; sleep 3",
      ], "claude-session-1");
      second = await Session.newSession(name, 80, 24, "/tmp", [
        "bash",
        "-c",
        "echo SECOND_OK; sleep 3",
      ], "claude-session-2");
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(500);
      expect(first.name).toBe(name);
      expect(second.name).toBe(name);
      expect(first.windowId).not.toBe(second.windowId);
      expect(first.paneId).not.toBe(second.paneId);
      expect(listWindows(name).sort()).toEqual([
        "claude-session-1",
        "claude-session-2",
      ]);
      expect(await first.capturePane()).toContain("FIRST_OK");
      expect(await second.capturePane()).toContain("SECOND_OK");
    } finally {
      await first?.kill().catch(() => {});
      await second?.kill().catch(() => {});
      await killSession(name).catch(() => {});
    }
  });

  test("concurrent session creation falls back to new-window without racing", async () => {
    const name = sharedSessionName();
    let first: Session | undefined;
    let second: Session | undefined;
    try {
      [first, second] = await Promise.all([
        Session.newSession(name, 80, 24, "/tmp", [
          "bash",
          "-c",
          "echo FIRST_OK; sleep 3",
        ], "claude-session-1"),
        Session.newSession(name, 80, 24, "/tmp", [
          "bash",
          "-c",
          "echo SECOND_OK; sleep 3",
        ], "claude-session-2"),
      ]);
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(500);
      expect(listWindows(name).sort()).toEqual([
        "claude-session-1",
        "claude-session-2",
      ]);
      expect(await first.capturePane()).toContain("FIRST_OK");
      expect(await second.capturePane()).toContain("SECOND_OK");
    } finally {
      await first?.kill().catch(() => {});
      await second?.kill().catch(() => {});
      await killSession(name).catch(() => {});
    }
  });

  test("killing one Claude window leaves sibling windows alive", async () => {
    const name = sharedSessionName();
    let first: Session | undefined;
    let second: Session | undefined;
    try {
      first = await Session.newSession(name, 80, 24, "/tmp", [
        "bash",
        "-c",
        "echo FIRST_OK; sleep 3",
      ], "claude-session-1");
      second = await Session.newSession(name, 80, 24, "/tmp", [
        "bash",
        "-c",
        "echo SECOND_OK; sleep 3",
      ], "claude-session-2");
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(500);
      await first.kill();
      await waitFor(() => {
        try {
          return listWindows(name).join(",") === "claude-session-2";
        } catch {
          return false;
        }
      }, 5000);

      expect(second.isAlive).toBe(true);
      expect(hasSession(name)).toBe(true);
      expect(listWindows(name)).toEqual(["claude-session-2"]);
      expect(await second.capturePane()).toContain("SECOND_OK");

      await second.kill();
      await waitFor(() => !hasSession(name), 5000);
      expect(hasSession(name)).toBe(false);
    } finally {
      await first?.kill().catch(() => {});
      await second?.kill().catch(() => {});
      await killSession(name).catch(() => {});
    }
  });

  test("interrupt signals the tmux pane process", async () => {
    const name = sharedSessionName();
    let sess: Session | undefined;
    try {
      sess = await Session.newSession(name, 80, 24, "/tmp", [
        "bash",
        "-lc",
        "sleep 30",
      ], "claude-session-interrupt");
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }
    try {
      await Bun.sleep(500);
      await sess.interrupt();
      await waitFor(() => !sess!.isAlive, 5000);
      expect(sess.isAlive).toBe(false);
    } finally {
      await sess?.kill().catch(() => {});
      await killSession(name).catch(() => {});
    }
  });
});
