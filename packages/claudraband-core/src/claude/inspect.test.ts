import { describe, expect, test } from "bun:test";
import { hasPendingNativePrompt, parseNativePermissionPrompt } from "./inspect";

describe("claude session inspection", () => {
  test("detects native Claude permission prompts from pane text", () => {
    const pane = `
Do you want to make this edit?
❯ 1. Yes, allow once
  2. No, and tell Claude what to do differently
`;

    expect(hasPendingNativePrompt(pane)).toBe(true);
    expect(parseNativePermissionPrompt(pane)).toEqual({
      question: "Do you want to make this edit?",
      options: [
        { number: "1", label: "Yes, allow once" },
        { number: "2", label: "No, and tell Claude what to do differently" },
      ],
    });
  });

  test("ignores unrelated pane content", () => {
    expect(hasPendingNativePrompt("INSERT\nClaude is idle\n")).toBe(false);
    expect(parseNativePermissionPrompt("plain text")).toBeNull();
  });
});
