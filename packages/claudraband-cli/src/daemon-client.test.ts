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
    claudeArgs: ["--effort", "high"],
    hasExplicitClaudeArgs: true,
    hasExplicitModel: true,
    hasExplicitPermissionMode: true,
    hasExplicitTerminalBackend: false,
    model: "opus",
    permissionMode: "bypassPermissions",
    terminalBackend: "auto",
    connect: "localhost:7842",
    host: "127.0.0.1",
    port: 7842,
    warnings: [],
    ...overrides,
  };
}

describe("daemon client helpers", () => {
  test("builds daemon session request bodies with overrides", () => {
    const body = __test.buildSessionRequestBody(makeConfig(), { requireLive: true });
    expect(body).toEqual({
      cwd: "/repo",
      claudeArgs: ["--effort", "high"],
      model: "opus",
      permissionMode: "bypassPermissions",
      requireLive: true,
    });
  });

  test("omits daemon default overrides when they were not explicitly requested", () => {
    const body = __test.buildSessionRequestBody(makeConfig({
      claudeArgs: [],
      hasExplicitClaudeArgs: false,
      hasExplicitModel: false,
      hasExplicitPermissionMode: false,
      model: "sonnet",
      permissionMode: "default",
    }));

    expect(body).toEqual({
      cwd: "/repo",
    });
  });

  test("sends deferred selections before awaiting the turn", async () => {
    const calls: string[] = [];
    const session = {
      async send(text: string) {
        calls.push(`send:${text}`);
      },
      async sendAndAwaitTurn(text: string) {
        calls.push(`send-and-await:${text}`);
        return { stopReason: "end_turn" as const };
      },
    };

    const result = await __test.answerPendingSelection(session, "2");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(calls).toEqual(["send-and-await:2"]);
  });

  test("sends the selected option before text-entry responses", async () => {
    const calls: string[] = [];
    const session = {
      async send(text: string) {
        calls.push(`send:${text}`);
      },
      async sendAndAwaitTurn(text: string) {
        calls.push(`send-and-await:${text}`);
        return { stopReason: "end_turn" as const };
      },
    };

    const result = await __test.answerPendingSelection(session, "3", "xyz");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(calls).toEqual(["send:3", "send-and-await:xyz"]);
  });

  test("cancels before sending follow-up text", async () => {
    const calls: string[] = [];
    const session = {
      async send(text: string) {
        calls.push(`send:${text}`);
      },
      async sendAndAwaitTurn(text: string) {
        calls.push(`send-and-await:${text}`);
        return { stopReason: "end_turn" as const };
      },
    };

    const result = await __test.answerPendingSelection(session, "0", "xyz");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(calls).toEqual(["send-and-await:0", "send-and-await:xyz"]);
  });
});
