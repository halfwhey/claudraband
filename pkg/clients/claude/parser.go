package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/halfwhey/allagent/pkg/wrap"
)

// tailer tails a Claude Code JSONL session file and emits wrap.Events.
type tailer struct {
	path   string
	events chan wrap.Event
	cancel context.CancelFunc
}

func newTailer(path string) *tailer {
	ctx, cancel := context.WithCancel(context.Background())
	t := &tailer{
		path:   path,
		events: make(chan wrap.Event, 256),
		cancel: cancel,
	}
	go t.run(ctx)
	return t
}

func (t *tailer) events_ch() <-chan wrap.Event { return t.events }

func (t *tailer) close() {
	t.cancel()
}

func (t *tailer) run(ctx context.Context) {
	defer close(t.events)

	for {
		if _, err := os.Stat(t.path); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
	var (
		offset  int64
		pending string
	)
	for {
		chunk, nextOffset, err := readAppended(t.path, offset)
		if err == nil && len(chunk) > 0 {
			offset = nextOffset
			pending += string(chunk)
			pending = t.emitCompleteLines(ctx, pending)
		} else if err == nil {
			offset = nextOffset
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (t *tailer) emitCompleteLines(ctx context.Context, pending string) string {
	for {
		idx := strings.IndexByte(pending, '\n')
		if idx < 0 {
			return pending
		}

		line := strings.TrimRight(pending[:idx], "\r")
		pending = pending[idx+1:]
		if line == "" {
			continue
		}
		for _, ev := range parseLineEvents(line) {
			select {
			case t.events <- ev:
			case <-ctx.Done():
				return pending
			}
		}
	}
}

func readAppended(path string, offset int64) ([]byte, int64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, offset, err
	}
	if fi.Size() < offset {
		offset = 0
	}
	if fi.Size() == offset {
		return nil, offset, nil
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, offset, err
	}
	defer f.Close()

	buf := make([]byte, fi.Size()-offset)
	n, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, offset, err
	}
	return buf[:n], offset + int64(n), nil
}

// -- JSON envelope types -----------------------------------------------------

type envelope struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	Timestamp string          `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
	Content   string          `json:"content"`
	Data      json.RawMessage `json:"data"`
}

type message struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content2  json.RawMessage `json:"content"`
}

// -- Parsing -----------------------------------------------------------------

func parseLineEvents(line string) []wrap.Event {
	var env envelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return nil
	}
	ts, _ := time.Parse(time.RFC3339Nano, env.Timestamp)

	switch env.Type {
	case "user":
		return parseMessageLineEvents(env, ts)
	case "system":
		if env.Content != "" {
			return []wrap.Event{{Kind: wrap.EventSystem, Time: ts, Text: env.Content, Role: "system"}}
		}
		return nil
	case "progress":
		if ev, ok := parseProgress(env, ts); ok {
			return []wrap.Event{ev}
		}
		return nil
	default:
		if len(env.Message) > 0 {
			return parseMessageLineEvents(env, ts)
		}
		return nil
	}
}

func parseMessageLineEvents(env envelope, ts time.Time) []wrap.Event {
	if len(env.Message) == 0 {
		return nil
	}
	var msg message
	if err := json.Unmarshal(env.Message, &msg); err != nil {
		return nil
	}
	if len(msg.Content) == 0 {
		return nil
	}

	// Try plain string content first.
	var str string
	if err := json.Unmarshal(msg.Content, &str); err == nil {
		kind := wrap.EventUserMessage
		if msg.Role == "assistant" {
			kind = wrap.EventAssistantText
		}
		return []wrap.Event{{Kind: kind, Time: ts, Text: str, Role: msg.Role}}
	}

	// Array of content blocks.
	var blocks []contentBlock
	if err := json.Unmarshal(msg.Content, &blocks); err != nil {
		return nil
	}

	var events []wrap.Event
	for _, b := range blocks {
		switch b.Type {
		case "text":
			kind := wrap.EventAssistantText
			if msg.Role == "user" {
				kind = wrap.EventUserMessage
			}
			events = append(events, wrap.Event{Kind: kind, Time: ts, Text: b.Text, Role: msg.Role})
		case "thinking":
			if b.Thinking != "" {
				events = append(events, wrap.Event{Kind: wrap.EventAssistantThink, Time: ts, Text: b.Thinking, Role: "assistant"})
			}
		case "tool_use":
			inp := "{}"
			if len(b.Input) > 0 {
				inp = string(b.Input)
			}
			events = append(events, wrap.Event{
				Kind:      wrap.EventToolCall,
				Time:      ts,
				Text:      fmt.Sprintf("%s(%s)", b.Name, truncate(inp, 80)),
				ToolName:  b.Name,
				ToolID:    b.ID,
				ToolInput: inp,
				Role:      "assistant",
			})
		case "tool_result":
			text := extractToolResultText(b)
			events = append(events, wrap.Event{
				Kind:   wrap.EventToolResult,
				Time:   ts,
				Text:   truncate(text, 200),
				ToolID: b.ToolUseID,
				Role:   "user",
			})
		}
	}
	return events
}

func parseProgress(env envelope, ts time.Time) (wrap.Event, bool) {
	if len(env.Data) == 0 {
		return wrap.Event{}, false
	}
	var d struct {
		Type  string `json:"type"`
		Query string `json:"query"`
	}
	if err := json.Unmarshal(env.Data, &d); err != nil {
		return wrap.Event{}, false
	}
	text := d.Type
	if d.Query != "" {
		text += ": " + d.Query
	}
	return wrap.Event{Kind: wrap.EventSystem, Time: ts, Text: text, Role: "system"}, true
}

func extractToolResultText(b contentBlock) string {
	if len(b.Content2) > 0 {
		var s string
		if json.Unmarshal(b.Content2, &s) == nil {
			return s
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(b.Content2, &blocks) == nil {
			var parts []string
			for _, bb := range blocks {
				if bb.Text != "" {
					parts = append(parts, bb.Text)
				}
			}
			return strings.Join(parts, "\n")
		}
		return string(b.Content2)
	}
	return "(no output)"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
