// Package config holds runtime configuration for allagent.
package config

import (
	"github.com/halfwhey/allagent/pkg/clients/claude"
)

const (
	defaultPaneWidth  = 120
	defaultPaneHeight = 40
)

// NewClaudeWrapper constructs a Claude Code wrapper with the given parameters.
func NewClaudeWrapper(model, cwd, tmuxSession string) *claude.Wrapper {
	if model == "" {
		model = "sonnet"
	}
	return claude.New(claude.Config{
		Model:       model,
		WorkingDir:  cwd,
		TmuxSession: tmuxSession,
		PaneWidth:   defaultPaneWidth,
		PaneHeight:  defaultPaneHeight,
	})
}
