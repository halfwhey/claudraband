import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

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
});
