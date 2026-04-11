import { describe, expect, test } from "bun:test";
import { parseArgs, splitShellWords } from "./args";

describe("claudraband cli args", () => {
  test("defaults terminal backend to auto", () => {
    const args = parseArgs(["hello"]);
    expect(args.terminalBackend).toBe("auto");
  });

  test("parses explicit terminal backend", () => {
    const args = parseArgs(["--terminal-backend", "xterm", "hello"]);
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

  test("splits quoted Claude args", () => {
    expect(splitShellWords("--append-system-prompt 'hello world' --effort high")).toEqual([
      "--append-system-prompt",
      "hello world",
      "--effort",
      "high",
    ]);
  });
});
