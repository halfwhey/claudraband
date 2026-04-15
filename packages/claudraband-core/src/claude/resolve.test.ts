import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { ClaudeWrapper } from "./claude";
import {
  __test,
  resolveClaudeExecutable,
  resolveClaudeLaunchCommand,
  resolveJavaScriptLauncher,
} from "./resolve";

const require = createRequire(import.meta.url);

describe("claude executable resolution", () => {
  const previousEnv = process.env[__test.ENV_OVERRIDE];

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env[__test.ENV_OVERRIDE];
    } else {
      process.env[__test.ENV_OVERRIDE] = previousEnv;
    }
  });

  test("prefers explicit executable path", () => {
    process.env[__test.ENV_OVERRIDE] = "/tmp/env-claude";
    expect(resolveClaudeExecutable("/tmp/explicit-claude")).toBe("/tmp/explicit-claude");
  });

  test("prefers environment override over bundled package", () => {
    process.env[__test.ENV_OVERRIDE] = "/tmp/env-claude";
    expect(resolveClaudeExecutable()).toBe("/tmp/env-claude");
  });

  test("resolves bundled @anthropic-ai/claude-code 2.1.96 binary", () => {
    delete process.env[__test.ENV_OVERRIDE];
    const executable = resolveClaudeExecutable();
    const packageJson = require("@anthropic-ai/claude-code/package.json") as { version: string };

    expect(packageJson.version).toBe("2.1.96");
    expect(executable).toContain("@anthropic-ai/claude-code");
    expect(executable.endsWith("cli.js")).toBe(true);
  });

  test("uses the current execPath for js entrypoints outside Bun", () => {
    expect(resolveJavaScriptLauncher({
      bunRuntime: false,
      execPath: "/tmp/node",
    })).toBe("/tmp/node");
  });

  test("prefers the bun binary for js entrypoints under Bun", () => {
    expect(resolveJavaScriptLauncher({
      bunRuntime: true,
      bunPath: "/tmp/bun",
      execPath: "/tmp/node",
    })).toBe("/tmp/bun");
  });

  test("falls back to bun on PATH for js entrypoints under Bun", () => {
    expect(resolveJavaScriptLauncher({
      bunRuntime: true,
      bunPath: null,
      execPath: "/tmp/node",
    })).toBe("bun");
  });

  test("launches js Claude entrypoints through the resolved js runtime", () => {
    expect(resolveClaudeLaunchCommand("/tmp/claude-cli.js")).toEqual([
      resolveJavaScriptLauncher(),
      "/tmp/claude-cli.js",
    ]);
  });

  test("launches native Claude binaries directly", () => {
    expect(resolveClaudeLaunchCommand("/tmp/claude-custom")).toEqual([
      "/tmp/claude-custom",
    ]);
  });

  test("ClaudeWrapper commands use the resolved executable path", () => {
    const wrapper = new ClaudeWrapper({
      claudeExecutable: "/tmp/claude-custom",
      claudeArgs: ["--effort", "high"],
      model: "opus",
      permissionMode: "acceptEdits",
      workingDir: "/tmp",
      terminalBackend: "tmux",
      tmuxSession: "claudraband-working-session",
      paneWidth: 80,
      paneHeight: 24,
    });

    const command = (wrapper as unknown as { buildCmd: (...args: string[]) => string[] })
      .buildCmd("--session-id", "abc-123");

    expect(command).toEqual([
      "/tmp/claude-custom",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--session-id",
      "abc-123",
    ]);
  });

  test("ClaudeWrapper commands launch js entrypoints through the resolved js runtime", () => {
    const wrapper = new ClaudeWrapper({
      claudeExecutable: "/tmp/claude-custom.js",
      claudeArgs: [],
      model: "opus",
      permissionMode: "default",
      workingDir: "/tmp",
      terminalBackend: "tmux",
      tmuxSession: "claudraband-working-session",
      paneWidth: 80,
      paneHeight: 24,
    });

    const command = (wrapper as unknown as { buildCmd: (...args: string[]) => string[] })
      .buildCmd("--session-id", "abc-123");

    expect(command).toEqual([
      resolveJavaScriptLauncher(),
      "/tmp/claude-custom.js",
      "--model",
      "opus",
      "--session-id",
      "abc-123",
    ]);
  });
});
