import { describe, expect, test } from "bun:test";
import { resolveTerminalBackend, resolveXtermTransportKind } from "./index";

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
});
