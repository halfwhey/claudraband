// Package wrap defines the Wrapper interface and Event types that form the
// contract between backend wrappers (Claude Code, Codex) and any consumer
// (the allagent TUI, tests, or future headless drivers).
package wrap

import "time"

// EventKind tags an Event with one of the categories a consumer needs.
type EventKind string

const (
	EventUserMessage    EventKind = "user_message"
	EventAssistantText  EventKind = "assistant_text"
	EventAssistantThink EventKind = "assistant_thinking"
	EventToolCall       EventKind = "tool_call"
	EventToolResult     EventKind = "tool_result"
	EventSystem         EventKind = "system"
	EventError          EventKind = "error"
	EventSessionStart   EventKind = "session_start"
	EventTurnStart      EventKind = "turn_start"
	EventTurnEnd        EventKind = "turn_end"
)

// Event is a backend-agnostic conversation event.
type Event struct {
	Kind EventKind
	Time time.Time

	// Text is the human-readable body: user prompt, assistant text, tool
	// output, etc. For tool calls it is a rendered summary; raw arguments
	// live in ToolInput.
	Text string

	// ToolName is set for tool-call / tool-result events.
	ToolName string

	// ToolID correlates a tool result back to its call.
	ToolID string

	// ToolInput is the raw JSON arguments of a tool call.
	ToolInput string

	// Role is "user" / "assistant" / "system" where applicable.
	Role string
}
