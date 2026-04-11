import { describe, expect, test } from "bun:test";
import { parseArgs, splitShellWords } from "./args";

const noopIo = {
  stdout: (_text: string) => {},
  stderr: (_text: string) => {},
  exit: (_code: number) => { throw new Error(`exit(${_code})`); },
};

describe("claudraband cli args", () => {
  test("defaults terminal backend to auto", () => {
    const args = parseArgs(["hello"]);
    expect(args.terminalBackend).toBe("auto");
  });

  test("parses explicit terminal backend", () => {
    const args = parseArgs(["--terminal-backend", "xterm", "-c", "--dangerously-skip-permissions", "hello"]);
    expect(args.terminalBackend).toBe("xterm");
    expect(args.prompt).toBe("hello");
  });

  test("parses --acp mode", () => {
    const args = parseArgs(["--acp", "--claude", "--model opus"]);
    expect(args.command).toBe("acp");
    expect(args.acp).toBe(true);
    expect(args.model).toBe("opus");
  });

  test("parses Claude launch flags from a single option", () => {
    const args = parseArgs([
      "--claude",
      "--model sonnet --effort high --bypass-all-permissions",
      "hello",
    ]);
    expect(args.model).toBe("sonnet");
    expect(args.permissionMode).toBe("default");
    expect(args.claudeArgs).toEqual(["--effort", "high", "--bypass-all-permissions"]);
    expect(args.prompt).toBe("hello");
  });

  test("parses --session/-s flag", () => {
    const args = parseArgs(["-s", "abc-123", "continue"]);
    expect(args.sessionId).toBe("abc-123");
    expect(args.prompt).toBe("continue");
    expect(args.command).toBe("prompt");
  });

  test("--select requires --session", () => {
    expect(() => parseArgs(["--select", "1", "hello"], noopIo as never)).toThrow("exit(1)");
  });

  test("--session without prompt/select/interactive errors", () => {
    expect(() => parseArgs(["-s", "abc-123"], noopIo as never)).toThrow("exit(1)");
  });

  test("--session with --select", () => {
    const args = parseArgs(["-s", "abc-123", "--select", "2"]);
    expect(args.sessionId).toBe("abc-123");
    expect(args.select).toBe("2");
  });

  test("session close command", () => {
    const args = parseArgs(["session", "close", "abc-123"]);
    expect(args.command).toBe("session-close");
    expect(args.sessionId).toBe("abc-123");
  });

  test("session close --all", () => {
    const args = parseArgs(["session", "close", "--all"]);
    expect(args.command).toBe("session-close");
    expect(args.closeAll).toBe(true);
    expect(args.sessionId).toBe("");
  });

  test("session close requires an id or --all", () => {
    expect(() => parseArgs(["session", "close"], noopIo as never)).toThrow("exit(1)");
  });

  test("serve command", () => {
    const args = parseArgs(["serve", "--port", "9000"]);
    expect(args.command).toBe("serve");
    expect(args.port).toBe(9000);
  });

  test("--server flag", () => {
    const args = parseArgs(["--server", "localhost:7842", "hello"]);
    expect(args.server).toBe("localhost:7842");
    expect(args.prompt).toBe("hello");
  });

  test("splits quoted Claude args", () => {
    expect(splitShellWords("--append-system-prompt 'hello world' --effort high")).toEqual([
      "--append-system-prompt",
      "hello world",
      "--effort",
      "high",
    ]);
  });
});
