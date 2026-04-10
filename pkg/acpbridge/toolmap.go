// Package acpbridge adapts a wrap.Wrapper (e.g. Claude Code running in tmux)
// into an ACP agent that communicates over stdio JSON-RPC.
package acpbridge

import (
	"encoding/json"

	"github.com/coder/acp-go-sdk"
)

// mapToolKind translates a Claude Code tool name into an ACP ToolKind.
func mapToolKind(toolName string) acp.ToolKind {
	switch toolName {
	case "Read", "ReadFile", "read_file":
		return acp.ToolKindRead
	case "Write", "WriteFile", "write_to_file":
		return acp.ToolKindEdit
	case "Edit", "EditFile", "str_replace_editor", "MultiEdit", "NotebookEdit":
		return acp.ToolKindEdit
	case "Bash", "bash", "execute_command":
		return acp.ToolKindExecute
	case "Grep", "Glob", "Search", "grep", "search", "find_file", "list_files":
		return acp.ToolKindSearch
	case "WebFetch", "WebSearch", "web_fetch", "fetch":
		return acp.ToolKindFetch
	case "Think", "think":
		return acp.ToolKindThink
	default:
		return acp.ToolKindOther
	}
}

// askUserQuestion represents the parsed input for AskUserQuestion tool calls.
type askUserQuestion struct {
	Questions []askUserQuestionItem `json:"questions"`
}

type askUserQuestionItem struct {
	Question    string                    `json:"question"`
	Header      string                    `json:"header"`
	MultiSelect bool                      `json:"multiSelect"`
	Options     []askUserQuestionOption    `json:"options"`
}

type askUserQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// parseAskUserQuestion decodes the AskUserQuestion tool input.
// Returns nil if the input is not parseable or has no questions.
func parseAskUserQuestion(rawInput string) *askUserQuestion {
	var q askUserQuestion
	if err := json.Unmarshal([]byte(rawInput), &q); err != nil || len(q.Questions) == 0 {
		return nil
	}
	return &q
}

// extractLocations attempts to pull file paths from a tool call's raw JSON input.
func extractLocations(rawInput string) []acp.ToolCallLocation {
	var input map[string]any
	if err := json.Unmarshal([]byte(rawInput), &input); err != nil {
		return nil
	}
	for _, key := range []string{"path", "file_path", "filename"} {
		if v, ok := input[key].(string); ok && v != "" {
			loc := acp.ToolCallLocation{Path: v}
			if line, ok := input["line"].(float64); ok && line > 0 {
				n := int(line)
				loc.Line = &n
			}
			return []acp.ToolCallLocation{loc}
		}
	}
	return nil
}
