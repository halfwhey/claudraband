package acpbridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/halfwhey/allagent/pkg/clients/claude"
	"github.com/halfwhey/allagent/pkg/wrap"
)

const (
	defaultPaneWidth  = 120
	defaultPaneHeight = 40

	// idleTimeout is how long the drain loop waits after the last event
	// (with no pending tool calls) before declaring the turn complete.
	idleTimeout = 3 * time.Second
)

// session tracks one ACP session backed by a Claude Code wrapper.
type session struct {
	id      string
	wrapper wrap.Wrapper
	cancel  context.CancelFunc // cancels current Prompt turn
}

// Bridge implements acp.Agent by forwarding prompts to a wrap.Wrapper
// (Claude Code in tmux) and streaming events back as ACP notifications.
type Bridge struct {
	conn     *acp.AgentSideConnection
	model    string
	sessions map[string]*session
	mu       sync.Mutex
	log      *slog.Logger
}

// Compile-time interface checks.
var _ acp.Agent = (*Bridge)(nil)

// New creates a Bridge with the given default model.
func New(model string) *Bridge {
	if model == "" {
		model = "sonnet"
	}
	return &Bridge{
		model:    model,
		sessions: make(map[string]*session),
		log:      slog.Default(),
	}
}

// SetAgentConnection stores the connection so we can send notifications.
func (b *Bridge) SetAgentConnection(conn *acp.AgentSideConnection) {
	b.conn = conn
}

// SetLogger overrides the default logger.
func (b *Bridge) SetLogger(l *slog.Logger) {
	b.log = l
}

// Shutdown stops all sessions and kills their tmux processes.
func (b *Bridge) Shutdown() {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(b.sessions)
	for sid, s := range b.sessions {
		b.log.Info("stopping session", "sid", sid)
		_ = s.wrapper.Stop()
	}
	b.sessions = make(map[string]*session)
	b.log.Info("shutdown complete", "sessions_stopped", n)
}

// ---------------------------------------------------------------------------
// acp.Agent methods
// ---------------------------------------------------------------------------

func (b *Bridge) Initialize(_ context.Context, params acp.InitializeRequest) (acp.InitializeResponse, error) {
	clientName := ""
	if params.ClientInfo != nil {
		clientName = params.ClientInfo.Name
		if params.ClientInfo.Version != "" {
			clientName += " " + params.ClientInfo.Version
		}
	}
	b.log.Info("client connected",
		"client", clientName,
		"protocol_version", params.ProtocolVersion,
	)
	return acp.InitializeResponse{
		ProtocolVersion: acp.ProtocolVersionNumber,
		AgentCapabilities: acp.AgentCapabilities{
			LoadSession: false,
		},
		AgentInfo: &acp.Implementation{
			Name:    "allagent",
			Title:   acp.Ptr("allagent (Claude Code)"),
			Version: "0.1.0",
		},
	}, nil
}

func (b *Bridge) Authenticate(_ context.Context, _ acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	return acp.AuthenticateResponse{}, nil
}

func (b *Bridge) NewSession(ctx context.Context, params acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	sid := randomID()
	tmuxName := "allagent-" + sid[:12]

	w := claude.New(claude.Config{
		Model:       b.model,
		WorkingDir:  params.Cwd,
		TmuxSession: tmuxName,
		PaneWidth:   defaultPaneWidth,
		PaneHeight:  defaultPaneHeight,
	})
	if err := w.Start(ctx); err != nil {
		return acp.NewSessionResponse{}, fmt.Errorf("start claude: %w", err)
	}

	b.mu.Lock()
	b.sessions[sid] = &session{id: sid, wrapper: w}
	b.mu.Unlock()

	b.log.Info("session created", "sid", sid, "cwd", params.Cwd, "model", b.model)
	return acp.NewSessionResponse{SessionId: acp.SessionId(sid)}, nil
}

func (b *Bridge) Prompt(_ context.Context, params acp.PromptRequest) (acp.PromptResponse, error) {
	sid := string(params.SessionId)
	b.mu.Lock()
	s, ok := b.sessions[sid]
	b.mu.Unlock()
	if !ok {
		return acp.PromptResponse{}, fmt.Errorf("session %s not found", sid)
	}

	// Cancel any prior turn.
	b.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	b.mu.Unlock()

	// Extract text from prompt content blocks.
	text := extractPromptText(params.Prompt)
	if text == "" {
		cancel()
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
	}

	b.log.Info("prompt received", "sid", sid, "length", len(text))

	if err := s.wrapper.Send(text); err != nil {
		cancel()
		return acp.PromptResponse{}, fmt.Errorf("send: %w", err)
	}

	reason := b.drainEvents(ctx, sid, s.wrapper)

	b.mu.Lock()
	s.cancel = nil
	b.mu.Unlock()

	b.log.Info("prompt completed", "sid", sid, "stop_reason", reason)
	return acp.PromptResponse{StopReason: reason}, nil
}

func (b *Bridge) Cancel(_ context.Context, params acp.CancelNotification) error {
	sid := string(params.SessionId)
	b.log.Info("cancel requested", "sid", sid)
	b.mu.Lock()
	s, ok := b.sessions[sid]
	b.mu.Unlock()
	if !ok {
		return nil
	}
	b.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	b.mu.Unlock()
	_ = s.wrapper.Interrupt()
	return nil
}

func (b *Bridge) SetSessionMode(_ context.Context, _ acp.SetSessionModeRequest) (acp.SetSessionModeResponse, error) {
	return acp.SetSessionModeResponse{}, nil
}

// ---------------------------------------------------------------------------
// Event draining
// ---------------------------------------------------------------------------

// drainEvents reads from the wrapper's event channel and sends ACP
// notifications until the turn completes or the context is cancelled.
func (b *Bridge) drainEvents(ctx context.Context, sid string, w wrap.Wrapper) acp.StopReason {
	var (
		pendingTools int
		gotResponse  bool
		idle         *time.Timer
	)

	resetIdle := func() {
		if idle != nil {
			idle.Stop()
		}
		idle = time.NewTimer(idleTimeout)
	}
	resetIdle()

	for {
		select {
		case <-ctx.Done():
			if idle != nil {
				idle.Stop()
			}
			return acp.StopReasonCancelled

		case ev, ok := <-w.Events():
			if !ok {
				// Channel closed -- backend died.
				if idle != nil {
					idle.Stop()
				}
				return acp.StopReasonEndTurn
			}
			resetIdle()
			b.log.Debug("event received", "sid", sid, "kind", ev.Kind, "tool", ev.ToolName, "text_len", len(ev.Text))
			b.sendEvent(ctx, sid, ev, &pendingTools, &gotResponse)

			if ev.Kind == wrap.EventToolCall && ev.ToolName == "AskUserQuestion" {
				b.handleUserQuestion(ctx, sid, ev, w)
			}

		case <-idle.C:
			if gotResponse && pendingTools <= 0 {
				b.log.Debug("idle timeout, ending turn", "sid", sid)
				return acp.StopReasonEndTurn
			}
			b.log.Debug("idle timeout, still waiting", "sid", sid, "pending_tools", pendingTools, "got_response", gotResponse)
			resetIdle()
		}
	}
}

// sendEvent translates a single wrap.Event into ACP notification(s).
func (b *Bridge) sendEvent(ctx context.Context, sid string, ev wrap.Event, pendingTools *int, gotResponse *bool) {
	sessionID := acp.SessionId(sid)

	var update *acp.SessionUpdate
	switch ev.Kind {
	case wrap.EventAssistantText:
		*gotResponse = true
		u := acp.UpdateAgentMessageText(ev.Text)
		update = &u

	case wrap.EventAssistantThink:
		u := acp.UpdateAgentThoughtText(ev.Text)
		update = &u

	case wrap.EventToolCall:
		*pendingTools++
		b.log.Info("tool call", "tool", ev.ToolName, "id", ev.ToolID, "pending", *pendingTools)
		kind := mapToolKind(ev.ToolName)
		locs := extractLocations(ev.ToolInput)
		var rawInput map[string]any
		_ = json.Unmarshal([]byte(ev.ToolInput), &rawInput)

		opts := []acp.ToolCallStartOpt{
			acp.WithStartKind(kind),
			acp.WithStartStatus(acp.ToolCallStatusInProgress),
		}
		if rawInput != nil {
			opts = append(opts, acp.WithStartRawInput(rawInput))
		}
		if len(locs) > 0 {
			opts = append(opts, acp.WithStartLocations(locs))
		}
		u := acp.StartToolCall(acp.ToolCallId(ev.ToolID), ev.ToolName, opts...)
		update = &u

	case wrap.EventToolResult:
		*pendingTools--
		if *pendingTools < 0 {
			*pendingTools = 0
		}
		b.log.Info("tool result", "id", ev.ToolID, "pending", *pendingTools)
		u := acp.UpdateToolCall(
			acp.ToolCallId(ev.ToolID),
			acp.WithUpdateStatus(acp.ToolCallStatusCompleted),
			acp.WithUpdateContent([]acp.ToolCallContent{
				acp.ToolContent(acp.TextBlock(ev.Text)),
			}),
		)
		update = &u

	case wrap.EventError:
		u := acp.UpdateAgentMessageText("Error: " + ev.Text)
		update = &u

	case wrap.EventSystem:
		if ev.Text == "" {
			return
		}
		u := acp.UpdateAgentThoughtText(ev.Text)
		update = &u

	default:
		// EventUserMessage, EventSessionStart, EventTurnStart, EventTurnEnd
		return
	}

	if update == nil {
		return
	}
	if err := b.conn.SessionUpdate(ctx, acp.SessionNotification{
		SessionId: sessionID,
		Update:    *update,
	}); err != nil {
		b.log.Error("failed to send session update", "err", err, "kind", ev.Kind)
	}
}

// ---------------------------------------------------------------------------
// AskUserQuestion -> ACP RequestPermission
// ---------------------------------------------------------------------------

// handleUserQuestion intercepts an AskUserQuestion tool call and forwards each
// question to the ACP client via RequestPermission. The selected option index
// is sent back to the tmux pane as a digit so Claude Code can continue.
func (b *Bridge) handleUserQuestion(ctx context.Context, sid string, ev wrap.Event, w wrap.Wrapper) {
	parsed := parseAskUserQuestion(ev.ToolInput)
	if parsed == nil {
		b.log.Warn("AskUserQuestion: could not parse input, sending default answer", "sid", sid)
		_ = w.Send("1")
		return
	}

	for _, q := range parsed.Questions {
		header := q.Header
		if header == "" {
			header = "Claude has a question"
		}

		opts := make([]acp.PermissionOption, 0, len(q.Options)+1)
		for i, opt := range q.Options {
			name := opt.Label
			if opt.Description != "" {
				name += " — " + opt.Description
			}
			opts = append(opts, acp.PermissionOption{
				Kind:     acp.PermissionOptionKindAllowOnce,
				OptionId: acp.PermissionOptionId(strconv.Itoa(i + 1)),
				Name:     name,
			})
		}
		opts = append(opts, acp.PermissionOption{
			Kind:     acp.PermissionOptionKindRejectOnce,
			OptionId: "0",
			Name:     "Cancel",
		})

		for _, opt := range opts {
			b.log.Debug("permission option", "sid", sid, "id", opt.OptionId, "name", opt.Name, "kind", opt.Kind)
		}

		content := []acp.ToolCallContent{acp.ToolContent(acp.TextBlock(q.Question))}
		kind := acp.ToolKindOther
		status := acp.ToolCallStatusInProgress

		resp, err := b.conn.RequestPermission(ctx, acp.RequestPermissionRequest{
			SessionId: acp.SessionId(sid),
			ToolCall: acp.RequestPermissionToolCall{
				ToolCallId: acp.ToolCallId(ev.ToolID),
				Title:      &header,
				Kind:       &kind,
				Status:     &status,
				Content:    content,
			},
			Options: opts,
		})

		if err != nil {
			b.log.Error("RequestPermission failed", "err", err, "sid", sid)
			_ = w.Interrupt()
			return
		}
		if resp.Outcome.Cancelled != nil {
			b.log.Info("user cancelled question", "sid", sid, "header", header)
			_ = w.Interrupt()
			return
		}
		if resp.Outcome.Selected != nil {
			id := string(resp.Outcome.Selected.OptionId)
			if id == "0" {
				b.log.Info("user selected cancel", "sid", sid, "header", header)
				_ = w.Interrupt()
				return
			}
			b.log.Info("user selected option", "sid", sid, "header", header, "optionId", id)
			if sendErr := w.Send(id); sendErr != nil {
				b.log.Error("failed to send answer to tmux", "err", sendErr)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractPromptText concatenates all text content blocks from a prompt.
func extractPromptText(blocks []acp.ContentBlock) string {
	var text string
	for _, b := range blocks {
		if b.Text != nil {
			text += b.Text.Text
		}
	}
	return text
}

func randomID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("sess_%d", time.Now().UnixNano())
	}
	return "sess_" + hex.EncodeToString(b[:])
}
