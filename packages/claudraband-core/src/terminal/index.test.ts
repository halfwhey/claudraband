import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hasSession, killSession } from "../tmuxctl";
import {
  __test,
  createTerminalBackendDriver,
  createTerminalHost,
  resolveTerminalBackend,
  resolveXtermTransportKind,
} from "./index";

function isSandboxTmuxError(err: unknown): boolean {
  return String(err).includes("Operation not permitted");
}

describe("terminal backend selection", () => {
  test("auto prefers tmux when available", () => {
    expect(resolveTerminalBackend("auto", () => true)).toBe("tmux");
  });

  test("auto falls back to xterm when tmux is unavailable", () => {
    expect(resolveTerminalBackend("auto", () => false)).toBe("xterm");
  });

  test("explicit tmux errors when tmux is unavailable", () => {
    expect(() => resolveTerminalBackend("tmux", () => false)).toThrow(
      "tmux is not available on PATH",
    );
  });

  test("xterm prefers Bun transport when available", () => {
    expect(resolveXtermTransportKind(() => true)).toBe("bun-terminal");
  });

  test("xterm falls back to node-pty when Bun transport is unavailable", () => {
    expect(resolveXtermTransportKind(() => false)).toBe("node-pty");
  });

  test("tmux host stop only kills its own Claude window", async () => {
    const sessionName = `claudraband-terminal-${randomUUID()}`;
    const first = createTerminalHost({
      backend: "tmux",
      tmuxSessionName: sessionName,
      tmuxWindowName: "claude-session-1",
    });
    const second = createTerminalHost({
      backend: "tmux",
      tmuxSessionName: sessionName,
      tmuxWindowName: "claude-session-2",
    });
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();

    try {
      await first.start(["bash", "-c", "echo FIRST_OK; sleep 3"], {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        signal: firstSignal.signal,
      });
      await second.start(["bash", "-c", "echo SECOND_OK; sleep 3"], {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        signal: secondSignal.signal,
      });
      await Bun.sleep(500);

      await first.stop();
      await Bun.sleep(200);

      expect(first.alive()).toBe(false);
      expect(second.alive()).toBe(true);
      expect(hasSession(sessionName)).toBe(true);
      expect(await second.capture()).toContain("SECOND_OK");
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    } finally {
      firstSignal.abort();
      secondSignal.abort();
      await first.stop().catch(() => {});
      await second.stop().catch(() => {});
      await killSession(sessionName).catch(() => {});
    }
  });

  test("tmux host reports the actual pane cwd", async () => {
    const sessionName = `claudraband-terminal-${randomUUID()}`;
    const host = createTerminalHost({
      backend: "tmux",
      tmuxSessionName: sessionName,
      tmuxWindowName: "claude-session-cwd",
    });
    const signal = new AbortController();

    try {
      await host.start(["bash", "-c", "sleep 3"], {
        cwd: "/tmp/",
        cols: 80,
        rows: 24,
        signal: signal.signal,
      });

      expect(await host.currentPath()).toBe("/tmp");
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    } finally {
      signal.abort();
      await host.stop().catch(() => {});
      await killSession(sessionName).catch(() => {});
    }
  });

  test("backend drivers expose reconnect capability", async () => {
    const tmuxDriver = createTerminalBackendDriver({
      backend: "tmux",
      tmuxSessionName: `claudraband-terminal-${randomUUID()}`,
    });
    const xtermDriver = createTerminalBackendDriver({
      backend: "xterm",
      tmuxSessionName: "unused",
    });

    expect(tmuxDriver.backend).toBe("tmux");
    expect(tmuxDriver.supportsLiveReconnect()).toBe(true);
    expect(xtermDriver.backend).toBe("xterm");
    expect(xtermDriver.supportsLiveReconnect()).toBe(false);
    expect(await xtermDriver.listLiveSessions()).toEqual([]);
  });

  test("xterm host sends user input through the terminal emulator", async () => {
    const host = __test.createXtermTerminalHost() as unknown as {
      send(input: string): Promise<void>;
      interrupt(): Promise<void>;
      transport: { write(data: string): void; interrupt(): Promise<boolean> } | null;
      terminal: { input(data: string): void } | null;
    };

    const transportWrites: string[] = [];
    const transportInterrupts: string[] = [];
    const terminalInputs: string[] = [];

    host.transport = {
      write(data: string) {
        transportWrites.push(data);
      },
      async interrupt() {
        transportInterrupts.push("SIGINT");
        return true;
      },
    };
    host.terminal = {
      input(data: string) {
        terminalInputs.push(data);
      },
    };

    await host.send("2");
    await host.interrupt();

    expect(terminalInputs).toEqual(["2", "\r"]);
    expect(transportInterrupts).toEqual(["SIGINT"]);
    expect(transportWrites).toEqual([]);
  });

  test("xterm host reports its configured cwd", async () => {
    const host = __test.createXtermTerminalHost() as unknown as {
      currentPath(): Promise<string | undefined>;
      cwd?: string;
    };

    host.cwd = "/tmp";
    expect(await host.currentPath()).toBe("/tmp");
  });
});
