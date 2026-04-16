import { describe, expect, test } from "bun:test";
import { EventKind, type ClaudrabandEvent } from "claudraband-core";
import { extractAttachTurnText } from "./attach-output";

function makeEvent(
  overrides: Partial<ClaudrabandEvent> & Pick<ClaudrabandEvent, "kind">,
): ClaudrabandEvent {
  return {
    kind: overrides.kind,
    time: overrides.time ?? new Date("2026-04-16T00:00:00.000Z"),
    text: overrides.text,
    toolName: overrides.toolName,
    toolID: overrides.toolID,
    toolInput: overrides.toolInput,
    role: overrides.role,
  };
}

describe("extractAttachTurnText", () => {
  test("returns only the new completed assistant turn", () => {
    const before = [
      makeEvent({ kind: EventKind.UserMessage, text: "old prompt", role: "user" }),
      makeEvent({ kind: EventKind.AssistantText, text: "old answer", role: "assistant" }),
      makeEvent({ kind: EventKind.TurnEnd, role: "assistant" }),
    ];
    const after = [
      ...before,
      makeEvent({
        kind: EventKind.UserMessage,
        text: "new prompt",
        role: "user",
        time: new Date("2026-04-16T00:00:01.000Z"),
      }),
      makeEvent({
        kind: EventKind.AssistantText,
        text: "new answer",
        role: "assistant",
        time: new Date("2026-04-16T00:00:02.000Z"),
      }),
      makeEvent({
        kind: EventKind.TurnEnd,
        role: "assistant",
        time: new Date("2026-04-16T00:00:03.000Z"),
      }),
    ];

    expect(extractAttachTurnText(before, after)).toBe("new answer");
  });

  test("returns an empty string when the new turn has no completed assistant message", () => {
    const before = [
      makeEvent({ kind: EventKind.UserMessage, text: "old prompt", role: "user" }),
      makeEvent({ kind: EventKind.AssistantText, text: "old answer", role: "assistant" }),
      makeEvent({ kind: EventKind.TurnEnd, role: "assistant" }),
    ];
    const after = [
      ...before,
      makeEvent({
        kind: EventKind.UserMessage,
        text: "follow-up prompt",
        role: "user",
        time: new Date("2026-04-16T00:00:01.000Z"),
      }),
      makeEvent({
        kind: EventKind.ToolCall,
        text: "AskUserQuestion({\"question\":\"red or blue?\"})",
        toolName: "AskUserQuestion",
        toolID: "toolu_pending",
        toolInput: "{\"question\":\"red or blue?\"}",
        role: "assistant",
        time: new Date("2026-04-16T00:00:02.000Z"),
      }),
    ];

    expect(extractAttachTurnText(before, after)).toBe("");
  });
});
