import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";
import { renderHelp } from "./help";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function captureHelp(argv: string[]): string {
  let stdout = "";
  try {
    parseArgs(argv, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      exit: (code) => {
        throw new ExitSignal(code);
      },
    });
  } catch (err) {
    expect((err as ExitSignal).code).toBe(0);
  }
  return stdout;
}

describe("claudraband cli help", () => {
  test("prints top-level help and exits zero", () => {
    expect(captureHelp(["--help"])).toBe(renderHelp("top"));
  });

  test("prints sessions help", () => {
    expect(captureHelp(["sessions", "--help"])).toBe(renderHelp("sessions"));
  });

  test("prints sessions close help", () => {
    expect(captureHelp(["sessions", "close", "--help"])).toBe(renderHelp("session-close"));
  });

  test("prints continue help", () => {
    expect(captureHelp(["continue", "--help"])).toBe(renderHelp("continue"));
  });
});
