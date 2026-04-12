import { describe, expect, test } from "bun:test";
import type { CliConfig } from "./args";
import { __test } from "./server";

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    command: "serve",
    prompt: "",
    sessionId: "",
    answer: "",
    allSessions: false,
    cwd: "/daemon-cwd",
    hasExplicitCwd: false,
    debug: false,
    claudeArgs: ["--append-system-prompt", "daemon"],
    hasExplicitClaudeArgs: true,
    hasExplicitModel: true,
    hasExplicitPermissionMode: true,
    hasExplicitTerminalBackend: false,
    model: "sonnet",
    permissionMode: "default",
    terminalBackend: "auto",
    connect: "",
    host: "127.0.0.1",
    port: 7842,
    warnings: [],
    ...overrides,
  };
}

describe("daemon server helpers", () => {
  test("defaults daemon backend to tmux unless explicitly requested", () => {
    expect(__test.resolveServerTerminalBackend(makeConfig())).toBe("tmux");
    expect(
      __test.resolveServerTerminalBackend(
        makeConfig({
          terminalBackend: "xterm",
          hasExplicitTerminalBackend: true,
        }),
      ),
    ).toBe("xterm");
  });

  test("formats IPv4 and IPv6 hosts for daemon URLs", () => {
    expect(__test.formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(__test.formatHostForUrl("::1")).toBe("[::1]");
  });

  test("resolves per-request session overrides", () => {
    const resolved = __test.resolveSessionConfig(makeConfig(), {
      cwd: "/repo",
      claudeArgs: ["--effort", "high"],
      model: "opus",
      permissionMode: "bypassPermissions",
    });

    expect(resolved).toEqual({
      cwd: "/repo",
      claudeArgs: ["--effort", "high"],
      model: "opus",
      permissionMode: "bypassPermissions",
    });
  });

  test("falls back to daemon defaults when request overrides are absent", () => {
    const resolved = __test.resolveSessionConfig(makeConfig(), {});

    expect(resolved).toEqual({
      cwd: "/daemon-cwd",
      claudeArgs: ["--append-system-prompt", "daemon"],
      model: "sonnet",
      permissionMode: "default",
    });
  });

  test("reuses only live daemon sessions", () => {
    expect(
      __test.shouldReuseSession({
        session: { isProcessAlive: () => true },
        sseClients: new Set(),
        pendingPermission: null,
      } as never),
    ).toBe(true);

    expect(
      __test.shouldReuseSession({
        session: { isProcessAlive: () => false },
        sseClients: new Set(),
        pendingPermission: null,
      } as never),
    ).toBe(false);

    expect(__test.shouldReuseSession(null)).toBe(false);
  });
});
