package claude

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/halfwhey/allagent/pkg/wrap"
)

func TestTailerReadsExistingLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.jsonl")

	lines := []string{
		`{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}`,
		`{"type":"","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}]}}`,
		`{"type":"","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/tmp/x"}}]}}`,
	}
	data := ""
	for _, l := range lines {
		data += l + "\n"
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}

	tl := newTailer(path)
	defer tl.close()

	var got []wrap.Event
	timeout := time.After(3 * time.Second)
	for len(got) < 3 {
		select {
		case ev := <-tl.events_ch():
			got = append(got, ev)
		case <-timeout:
			t.Fatalf("timed out, got %d events: %+v", len(got), got)
		}
	}

	if got[0].Kind != wrap.EventUserMessage {
		t.Errorf("event 0: want user_message, got %s", got[0].Kind)
	}
	if got[0].Text != "hello" {
		t.Errorf("event 0 text: want 'hello', got %q", got[0].Text)
	}
	if got[1].Kind != wrap.EventAssistantText {
		t.Errorf("event 1: want assistant_text, got %s", got[1].Kind)
	}
	if got[2].Kind != wrap.EventToolCall {
		t.Errorf("event 2: want tool_call, got %s", got[2].Kind)
	}
	if got[2].ToolName != "Read" {
		t.Errorf("event 2 tool: want 'Read', got %q", got[2].ToolName)
	}
}

func TestTailerWaitsForFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "delayed.jsonl")

	tl := newTailer(path)
	defer tl.close()

	go func() {
		time.Sleep(500 * time.Millisecond)
		_ = os.WriteFile(path, []byte(`{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"delayed msg"}}`+"\n"), 0o644)
	}()

	select {
	case ev := <-tl.events_ch():
		if ev.Kind != wrap.EventUserMessage || ev.Text != "delayed msg" {
			t.Errorf("unexpected event: %+v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for delayed file")
	}
}

func TestTailerReadsAppendedLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "append.jsonl")

	initial := `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}

	tl := newTailer(path)
	defer tl.close()

	select {
	case ev := <-tl.events_ch():
		if ev.Kind != wrap.EventUserMessage || ev.Text != "hello" {
			t.Fatalf("unexpected initial event: %+v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for initial event")
	}

	appended := `{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"appended reply"}]}}` + "\n"
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(appended); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	_ = f.Close()

	select {
	case ev := <-tl.events_ch():
		if ev.Kind != wrap.EventAssistantText || ev.Text != "appended reply" {
			t.Fatalf("unexpected appended event: %+v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for appended event")
	}
}

func TestTailerEmitsMultipleContentBlocks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "multi.jsonl")

	line := `{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/tmp/x"}},{"type":"text","text":"done"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}

	tl := newTailer(path)
	defer tl.close()

	var got []wrap.Event
	timeout := time.After(3 * time.Second)
	for len(got) < 2 {
		select {
		case ev := <-tl.events_ch():
			got = append(got, ev)
		case <-timeout:
			t.Fatalf("timed out waiting for multi-block events, got %d: %+v", len(got), got)
		}
	}

	if got[0].Kind != wrap.EventToolCall || got[0].ToolName != "Read" {
		t.Fatalf("unexpected first event: %+v", got[0])
	}
	if got[1].Kind != wrap.EventAssistantText || got[1].Text != "done" {
		t.Fatalf("unexpected second event: %+v", got[1])
	}
}
