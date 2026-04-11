export enum EventKind {
  UserMessage = "user_message",
  AssistantText = "assistant_text",
  AssistantThinking = "assistant_thinking",
  ToolCall = "tool_call",
  ToolResult = "tool_result",
  System = "system",
  Error = "error",
  SessionStart = "session_start",
  TurnStart = "turn_start",
  TurnEnd = "turn_end",
}

export interface Event {
  kind: EventKind;
  time: Date;
  text: string;
  toolName: string;
  toolID: string;
  toolInput: string;
  role: string;
}

export function makeEvent(partial: Partial<Event> & { kind: EventKind }): Event {
  return {
    time: new Date(),
    text: "",
    toolName: "",
    toolID: "",
    toolInput: "",
    role: "",
    ...partial,
  };
}
