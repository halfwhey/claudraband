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
    json: false,
    pretty: false,
    follow: true,
    claudeArgs: ["--append-system-prompt", "daemon"],
    hasExplicitClaudeArgs: true,
    hasExplicitModel: true,
    hasExplicitPermissionMode: true,
    autoAcceptStartupPrompts: false,
    hasExplicitTerminalBackend: false,
    hasExplicitTurnDetection: true,
    model: "sonnet",
    permissionMode: "default",
    terminalBackend: "auto",
    turnDetection: "events",
    connect: "",
    host: "127.0.0.1",
    port: 7842,
    warnings: [],
    ...overrides,
  };
}

describe("daemon server helpers", () => {
  test("treats an empty optional JSON body as an empty object", () => {
    expect(__test.parseOptionalJsonObject<Record<string, unknown>>("")).toEqual({});
    expect(
      __test.parseOptionalJsonObject<Record<string, unknown>>("   \n"),
    ).toEqual({});
  });

  test("parses non-empty optional JSON bodies normally", () => {
    expect(
      __test.parseOptionalJsonObject<{ requireLive: boolean }>('{ "requireLive": true }'),
    ).toEqual({ requireLive: true });
  });

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
      turnDetection: "events",
    });

    expect(resolved).toEqual({
      cwd: "/repo",
      claudeArgs: ["--effort", "high"],
      model: "opus",
      permissionMode: "bypassPermissions",
      autoAcceptStartupPrompts: false,
      turnDetection: "events",
    });
  });

  test("falls back to daemon defaults when request overrides are absent", () => {
    const resolved = __test.resolveSessionConfig(makeConfig(), {});

    expect(resolved).toEqual({
      cwd: "/daemon-cwd",
      claudeArgs: ["--append-system-prompt", "daemon"],
      model: "sonnet",
      permissionMode: "default",
      autoAcceptStartupPrompts: false,
      turnDetection: "events",
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
