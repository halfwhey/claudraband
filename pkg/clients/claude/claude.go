// Package claude implements a wrap.Wrapper for Claude Code. It spawns the
// `claude` CLI inside a detached tmux session and tails the JSONL session file
// for structured events.
package claude

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/halfwhey/allagent/pkg/tmuxctl"
	"github.com/halfwhey/allagent/pkg/wrap"
)

// Config holds Claude-specific settings.
type Config struct {
	Model       string
	WorkingDir  string
	TmuxSession string
	PaneWidth   int
	PaneHeight  int
}

// Wrapper wraps Claude Code.
type Wrapper struct {
	cfg       Config
	tmux      *tmuxctl.Session
	tl        *tailer
	sessionID string
	cancel    context.CancelFunc
	events    chan wrap.Event
}

// New creates a Claude Code wrapper with the given config.
func New(cfg Config) *Wrapper {
	return &Wrapper{
		cfg:    cfg,
		events: make(chan wrap.Event, 256),
	}
}

func (w *Wrapper) Name() string  { return "claude" }
func (w *Wrapper) Model() string { return w.cfg.Model }

func (w *Wrapper) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	w.cancel = cancel

	w.sessionID = uuid.New().String()

	cmd := []string{
		"claude",
		"--model", w.cfg.Model,
		"--session-id", w.sessionID,
	}

	sess, err := tmuxctl.NewSession(
		w.cfg.TmuxSession,
		w.cfg.PaneWidth,
		w.cfg.PaneHeight,
		w.cfg.WorkingDir,
		cmd,
	)
	if err != nil {
		cancel()
		return fmt.Errorf("claude: start tmux: %w", err)
	}
	w.tmux = sess

	jsonlPath := sessionPath(w.cfg.WorkingDir, w.sessionID)
	w.tl = newTailer(jsonlPath)

	// Bridge tailer events to the wrapper's channel so consumers that
	// called Events() before Start() still receive everything.
	go func() {
		for ev := range w.tl.events_ch() {
			select {
			case w.events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()

	go func() {
		<-ctx.Done()
		w.tl.close()
		_ = w.tmux.Kill()
	}()

	return nil
}

func (w *Wrapper) Stop() error {
	if w.cancel != nil {
		w.cancel()
	}
	if w.tmux != nil {
		return w.tmux.Kill()
	}
	return nil
}

func (w *Wrapper) Send(input string) error {
	if w.tmux == nil {
		return fmt.Errorf("claude: not started")
	}
	return w.tmux.SendLine(input)
}

func (w *Wrapper) Interrupt() error {
	if w.tmux == nil {
		return fmt.Errorf("claude: not started")
	}
	return w.tmux.Interrupt()
}

func (w *Wrapper) Alive() bool {
	return w.tmux != nil && w.tmux.Alive()
}

func (w *Wrapper) Events() <-chan wrap.Event {
	return w.events
}

// sessionPath computes the on-disk path Claude Code uses for session files.
func sessionPath(cwd, sessionID string) string {
	home, _ := os.UserHomeDir()
	escaped := strings.ReplaceAll(cwd, "/", "-")
	return filepath.Join(home, ".claude", "projects", escaped, sessionID+".jsonl")
}
