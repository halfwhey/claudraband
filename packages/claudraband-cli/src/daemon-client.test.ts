import { describe, expect, test } from "bun:test";
import type { CliConfig, } from "./args";
import { __test } from "./daemon-client";

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    command: "prompt",
    prompt: "",
    sessionId: "",
    answer: "",
    allSessions: false,
    cwd: "/repo",
    hasExplicitCwd: false,
    debug: false,
    json: false,
    pretty: false,
    follow: true,
    claudeArgs: ["--effort", "high"],
    hasExplicitClaudeArgs: true,
    hasExplicitModel: true,
    hasExplicitPermissionMode: true,
    autoAcceptStartupPrompts: false,
    hasExplicitTerminalBackend: false,
    hasExplicitTurnDetection: true,
    model: "opus",
    permissionMode: "bypassPermissions",
    terminalBackend: "auto",
    turnDetection: "events",
    connect: "localhost:7842",
    host: "127.0.0.1",
    port: 7842,
    warnings: [],
    ...overrides,
  };
}

describe("daemon client helpers", () => {
  test("builds daemon session request bodies with overrides", () => {
    const body = __test.buildSessionRequestBody(makeConfig(), {
      requireLive: true,
      sessionId: "sid-123",
    });
    expect(body).toEqual({
      sessionId: "sid-123",
      cwd: "/repo",
      claudeArgs: ["--effort", "high"],
      model: "opus",
      permissionMode: "bypassPermissions",
      autoAcceptStartupPrompts: false,
      turnDetection: "events",
      requireLive: true,
    });
  });

  test("omits daemon default overrides when they were not explicitly requested", () => {
    const body = __test.buildSessionRequestBody(makeConfig({
      claudeArgs: [],
      hasExplicitClaudeArgs: false,
      hasExplicitModel: false,
      hasExplicitPermissionMode: false,
      hasExplicitTurnDetection: false,
      model: "sonnet",
      permissionMode: "default",
      turnDetection: "terminal",
    }));

    expect(body).toEqual({
      cwd: "/repo",
      autoAcceptStartupPrompts: false,
    });
  });

});
