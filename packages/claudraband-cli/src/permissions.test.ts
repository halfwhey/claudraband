import { describe, expect, test } from "bun:test";
import { autoDecisionForPermissionMode } from "./permissions";

const editRequest = {
  source: "native_prompt" as const,
  sessionId: "session",
  toolCallId: "tool",
  title: "Write: create fib.cpp?",
  kind: "edit" as const,
  content: [{ type: "text" as const, text: "create fib.cpp" }],
  options: [
    { kind: "allow_once" as const, optionId: "1", name: "Yes" },
    { kind: "allow_once" as const, optionId: "2", name: "Yes, allow all edits during this session" },
    { kind: "reject_once" as const, optionId: "3", name: "No" },
  ],
};

describe("permission auto-selection", () => {
  test("auto mode selects the first non-text allow option", () => {
    expect(autoDecisionForPermissionMode("auto", editRequest)).toEqual({
      outcome: "selected",
      optionId: "1",
    });
  });

  test("acceptEdits only auto-selects edit requests", () => {
    expect(autoDecisionForPermissionMode("acceptEdits", editRequest)).toEqual({
      outcome: "selected",
      optionId: "1",
    });
    expect(autoDecisionForPermissionMode("acceptEdits", {
      ...editRequest,
      kind: "execute",
    })).toBeNull();
  });

  test("default mode leaves permissions for interactive handling", () => {
    expect(autoDecisionForPermissionMode("default", editRequest)).toBeNull();
  });
});
