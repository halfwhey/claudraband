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

  test("detects trust folder prompt from pane text", () => {
    const pane = `
 Accessing workspace:

 /Users/ludvi

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit
`;

    expect(hasPendingNativePrompt(pane)).toBe(true);
    const parsed = parseNativePermissionPrompt(pane);
    expect(parsed).not.toBeNull();
    expect(parsed!.question).toContain("Is this a project you created");
    expect(parsed!.options).toEqual([
      { number: "1", label: "Yes, I trust this folder" },
      { number: "2", label: "No, exit" },
    ]);
  });

  test("detects bypass permissions prompt from pane text", () => {
    const pane = `
  WARNING: Claude Code running in Bypass Permissions mode

  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
  This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.



  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

  ❯ 1. No, exit
    2. Yes, I accept

  Enter to confirm · Esc to cancel
`;

    expect(hasPendingNativePrompt(pane)).toBe(true);
    const parsed = parseNativePermissionPrompt(pane);
    expect(parsed).not.toBeNull();
    expect(parsed!.question).toContain("you accept all responsibility");
    expect(parsed!.options).toEqual([
      { number: "1", label: "No, exit" },
      { number: "2", label: "Yes, I accept" },
    ]);
  });

  test("detects bypass permissions prompt from xterm serialized pane text", () => {
    const pane = `
\u001b[38;5;211m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
\u001b[2C\u001b[1mWARNING:\u001b[1CClaude\u001b[1CCode\u001b[1Crunning\u001b[1Cin\u001b[1CBypass\u001b[1CPermissions\u001b[1Cmode

\u001b[2C\u001b[0mIn\u001b[1CBypass\u001b[1CPermissions\u001b[1Cmode,\u001b[1CClaude\u001b[1CCode\u001b[1Cwill\u001b[1Cnot\u001b[1Cask\u001b[1Cfor\u001b[1Cyour\u001b[1Capproval\u001b[1Cbefore\u001b[1Crunning\u001b[1Cpotentially\u001b[1Cdangerous
\u001b[2Ccommands.
\u001b[2CThis\u001b[1Cmode\u001b[1Cshould\u001b[1Conly\u001b[1Cbe\u001b[1Cused\u001b[1Cin\u001b[1Ca\u001b[1Csandboxed\u001b[1Ccontainer/VM\u001b[1Cthat\u001b[1Chas\u001b[1Crestricted\u001b[1Cinternet\u001b[1Caccess\u001b[1Cand\u001b[1Ccan\u001b[1Ceasily\u001b[1Cbe
\u001b[2Crestored\u001b[1Cif\u001b[1Cdamaged.

\u001b[2CBy\u001b[1Cproceeding,\u001b[1Cyou\u001b[1Caccept\u001b[1Call\u001b[1Cresponsibility\u001b[1Cfor\u001b[1Cactions\u001b[1Ctaken\u001b[1Cwhile\u001b[1Crunning\u001b[1Cin\u001b[1CBypass\u001b[1CPermissions\u001b[1Cmode.

\u001b[2Chttps://code.claude.com/docs/en/security

\u001b[2C\u001b[38;5;153m❯\u001b[1C\u001b[38;5;246m1.\u001b[1C\u001b[38;5;153mNo,\u001b[1Cexit
\u001b[4C\u001b[38;5;246m2.\u001b[1C\u001b[0mYes,\u001b[1CI\u001b[1Caccept

\u001b[2C\u001b[38;5;246;3mEnter\u001b[1Cto\u001b[1Cconfirm\u001b[1C·\u001b[1CEsc\u001b[1Cto\u001b[1Ccancel\u001b[3A\u001b[32D\u001b[0m\u001b[?2004h\u001b[?1004h
`;

    expect(hasPendingNativePrompt(pane)).toBe(true);
    const parsed = parseNativePermissionPrompt(pane);
    expect(parsed).not.toBeNull();
    expect(parsed!.question).toContain("you accept all responsibility");
    expect(parsed!.options).toEqual([
      { number: "1", label: "No, exit" },
      { number: "2", label: "Yes, I accept" },
    ]);
  });

  test("does not match trust prompt without both options", () => {
    const partial = `
 Is this a project you created or one you trust?
 ❯ 1. Yes, I trust this folder
`;
    expect(hasPendingNativePrompt(partial)).toBe(false);
  });

  test("does not match bypass prompt without both markers", () => {
    const partial = `
  WARNING: Claude Code running in Bypass Permissions mode
  ❯ 1. No, exit
`;
    expect(hasPendingNativePrompt(partial)).toBe(false);
  });

  test("ignores unrelated pane content", () => {
    expect(hasPendingNativePrompt("INSERT\nClaude is idle\n")).toBe(false);
    expect(parseNativePermissionPrompt("plain text")).toBeNull();
  });
});
