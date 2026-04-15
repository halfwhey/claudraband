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
    expect(args.hasExplicitTerminalBackend).toBe(false);
    expect(args.turnDetection).toBe("terminal");
    expect(args.hasExplicitTurnDetection).toBe(false);
  });

  test("parses explicit backend, turn detection, and top-level flags", () => {
    const args = parseArgs([
      "--backend",
      "xterm",
      "--turn-detection",
      "events",
      "--model",
      "opus",
      "--permission-mode",
      "bypassPermissions",
      "hello",
    ]);
    expect(args.terminalBackend).toBe("xterm");
    expect(args.hasExplicitTerminalBackend).toBe(true);
    expect(args.turnDetection).toBe("events");
    expect(args.hasExplicitTurnDetection).toBe(true);
    expect(args.model).toBe("opus");
    expect(args.permissionMode).toBe("bypassPermissions");
    expect(args.prompt).toBe("hello");
  });

  test("allows local xterm prompts without forcing dangerous permission flags", () => {
    const args = parseArgs(["--backend", "xterm", "hello"]);
    expect(args.terminalBackend).toBe("xterm");
    expect(args.prompt).toBe("hello");
  });

  test("parses acp command", () => {
    const args = parseArgs(["acp", "--claude", "--model opus"]);
    expect(args.command).toBe("acp");
    expect(args.model).toBe("opus");
  });

  test("rejects removed --acp alias", () => {
    expect(() => parseArgs(["--acp"], noopIo as never)).toThrow("exit(1)");
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

  test("parses prompt with --session auto-resumes", () => {
    const args = parseArgs(["prompt", "--session", "abc-123", "continue"]);
    expect(args.sessionId).toBe("abc-123");
    expect(args.prompt).toBe("continue");
    expect(args.command).toBe("prompt");
  });

  test("rejects removed -s shorthand", () => {
    expect(() => parseArgs(["-s", "abc-123", "keep going"], noopIo as never)).toThrow("exit(1)");
  });

  test("rejects removed answer command", () => {
    expect(() => parseArgs(["answer", "abc-123", "2"], noopIo as never)).toThrow("exit(1)");
  });

  test("rejects removed continue command", () => {
    expect(() => parseArgs(["continue", "abc-123", "keep going"], noopIo as never)).toThrow("exit(1)");
  });

  test("parses prompt --select selection flow", () => {
    const args = parseArgs(["prompt", "--session", "abc-123", "--select", "2"]);
    expect(args.command).toBe("prompt");
    expect(args.sessionId).toBe("abc-123");
    expect(args.answer).toBe("2");
    expect(args.prompt).toBe("");
  });

  test("parses prompt --select with text response", () => {
    const args = parseArgs(["prompt", "--session", "abc-123", "--select", "3", "xyz"]);
    expect(args.command).toBe("prompt");
    expect(args.sessionId).toBe("abc-123");
    expect(args.answer).toBe("3");
    expect(args.prompt).toBe("xyz");
  });

  test("parses send command", () => {
    const args = parseArgs(["send", "--session", "abc-123", "quick note"]);
    expect(args.command).toBe("send");
    expect(args.sessionId).toBe("abc-123");
    expect(args.prompt).toBe("quick note");
  });

  test("parses watch command", () => {
    const args = parseArgs(["watch", "--session", "abc-123"]);
    expect(args.command).toBe("watch");
    expect(args.sessionId).toBe("abc-123");
  });

  test("parses interrupt command", () => {
    const args = parseArgs(["interrupt", "--session", "abc-123"]);
    expect(args.command).toBe("interrupt");
    expect(args.sessionId).toBe("abc-123");
  });

  test("rejects removed -s shorthand with --select", () => {
    expect(() => parseArgs(["-s", "abc-123", "--select", "2"], noopIo as never)).toThrow("exit(1)");
  });

  test("parses attach command", () => {
    const args = parseArgs(["attach", "abc-123"]);
    expect(args.command).toBe("attach");
    expect(args.sessionId).toBe("abc-123");
  });

  test("rejects removed interactive shorthand", () => {
    expect(() => parseArgs(["-s", "abc-123", "-i"], noopIo as never)).toThrow("exit(1)");
  });

  test("rejects removed --terminal-backend alias", () => {
    expect(() => parseArgs(["--terminal-backend", "tmux", "hello"], noopIo as never))
      .toThrow("exit(1)");
  });

  test("sessions close command", () => {
    const args = parseArgs(["sessions", "close", "abc-123"]);
    expect(args.command).toBe("session-close");
    expect(args.sessionId).toBe("abc-123");
  });

  test("sessions close --all", () => {
    const args = parseArgs(["sessions", "close", "--all"]);
    expect(args.command).toBe("session-close");
    expect(args.allSessions).toBe(true);
    expect(args.sessionId).toBe("");
  });

  test("sessions list defaults to all tracked sessions", () => {
    const args = parseArgs(["sessions"]);
    expect(args.command).toBe("sessions");
    expect(args.allSessions).toBe(false);
  });

  test("sessions close --cwd targets bulk close by cwd", () => {
    const args = parseArgs(["sessions", "close", "--cwd", "/tmp/demo"]);
    expect(args.command).toBe("session-close");
    expect(args.sessionId).toBe("");
    expect(args.cwd).toBe("/tmp/demo");
    expect(args.hasExplicitCwd).toBe(true);
  });

  test("sessions close requires an id, --all, or --cwd", () => {
    expect(() => parseArgs(["sessions", "close"], noopIo as never)).toThrow("exit(1)");
  });

  test("sessions close rejects mixed bulk scopes", () => {
    expect(() => parseArgs(["sessions", "close", "--all", "--cwd", "/tmp"], noopIo as never))
      .toThrow("exit(1)");
  });

  test("sessions rejects --all", () => {
    expect(() => parseArgs(["sessions", "--all"], noopIo as never)).toThrow("exit(1)");
  });

  test("serve command", () => {
    const args = parseArgs(["serve", "--port", "9000"]);
    expect(args.command).toBe("serve");
    expect(args.port).toBe(9000);
  });

  test("serve host flag", () => {
    const args = parseArgs(["serve", "--host", "0.0.0.0", "--port", "9000"]);
    expect(args.command).toBe("serve");
    expect(args.host).toBe("0.0.0.0");
    expect(args.port).toBe(9000);
  });

  test("connect flag is allowed for new prompts", () => {
    const args = parseArgs(["--connect", "localhost:7842", "hello"]);
    expect(args.connect).toBe("localhost:7842");
    expect(args.prompt).toBe("hello");
    expect(args.command).toBe("prompt");
  });

  test("connect flag is rejected for tracked session commands", () => {
    expect(() => parseArgs(["continue", "abc-123", "--connect", "localhost:7842", "hello"], noopIo as never))
      .toThrow("exit(1)");
  });

  test("--select is rejected without --session", () => {
    expect(() => parseArgs(["hello", "--select", "2"], noopIo as never)).toThrow("exit(1)");
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
