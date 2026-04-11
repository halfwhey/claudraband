import { describe, expect, test } from "bun:test";
import { shouldDispatchToBun } from "./dispatch";

describe("claudraband bin dispatch", () => {
  test("dispatches to bun when running under node and bun is available", () => {
    expect(shouldDispatchToBun({
      bunRuntime: false,
      bunAvailable: true,
      alreadyDispatched: false,
    })).toBe(true);
  });

  test("does not dispatch when already running under bun", () => {
    expect(shouldDispatchToBun({
      bunRuntime: true,
      bunAvailable: true,
      alreadyDispatched: false,
    })).toBe(false);
  });

  test("does not dispatch again after re-exec", () => {
    expect(shouldDispatchToBun({
      bunRuntime: false,
      bunAvailable: true,
      alreadyDispatched: true,
    })).toBe(false);
  });
});
