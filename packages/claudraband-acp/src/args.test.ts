import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE } from "./args";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe("claudraband-acp args", () => {
  test("defaults terminal backend to auto", () => {
    expect(parseArgs([]).terminalBackend).toBe("auto");
  });

  test("prints help and exits zero", () => {
    let stdout = "";
    expect(() =>
      parseArgs(["--help"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        exit: (code) => {
          throw new ExitSignal(code);
        },
      }),
    ).toThrow(ExitSignal);
    expect(stdout).toBe(USAGE);
    try {
      parseArgs(["--help"], {
        stdout: () => {},
        stderr: () => {},
        exit: (code) => {
          throw new ExitSignal(code);
        },
      });
    } catch (err) {
      expect((err as ExitSignal).code).toBe(0);
    }
  });
});
