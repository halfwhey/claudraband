import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE } from "./args";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe("claudraband cli help", () => {
  test("prints help and exits zero", () => {
    let stdout = "";
    try {
      parseArgs(["--help"], {
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
    expect(stdout).toBe(USAGE);
  });
});
