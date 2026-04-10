// Package tmuxctl is a thin wrapper around the tmux CLI for the operations
// allagent needs: spawn a detached session running a backend, send keys to it,
// capture its visible pane, resize it, and kill it.
package tmuxctl

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Session represents a detached tmux session hosting a single backend pane.
type Session struct {
	Name    string
	Command []string
}

// HasSession reports whether a tmux session with the given name exists.
func HasSession(name string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", name)
	return cmd.Run() == nil
}

// NewSession creates a detached tmux session running `command` inside a pane
// of the requested size. If a session with the same name already exists it is
// killed first.
func NewSession(name string, width, height int, workingDir string, command []string) (*Session, error) {
	if len(command) == 0 {
		return nil, errors.New("tmuxctl: command is required")
	}
	if HasSession(name) {
		if err := KillSession(name); err != nil {
			return nil, fmt.Errorf("kill existing session: %w", err)
		}
	}
	args := []string{
		"new-session", "-d",
		"-s", name,
		"-x", strconv.Itoa(width),
		"-y", strconv.Itoa(height),
	}
	if workingDir != "" {
		args = append(args, "-c", workingDir)
	}
	args = append(args, command...)

	cmd := exec.Command("tmux", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("tmux new-session: %w (stderr=%s)", err, stderr.String())
	}
	_ = exec.Command("tmux", "set-option", "-t", name, "status", "off").Run()
	return &Session{Name: name, Command: command}, nil
}

// KillSession terminates a tmux session by name (no-op if absent).
func KillSession(name string) error {
	if !HasSession(name) {
		return nil
	}
	return exec.Command("tmux", "kill-session", "-t", name).Run()
}

func (s *Session) Kill() error    { return KillSession(s.Name) }
func (s *Session) Alive() bool    { return HasSession(s.Name) }
func (s *Session) target() string { return s.Name + ":0.0" }

// Resize changes the pane size of the session's only window.
func (s *Session) Resize(width, height int) error {
	return exec.Command("tmux", "resize-window",
		"-t", s.Name,
		"-x", strconv.Itoa(width),
		"-y", strconv.Itoa(height),
	).Run()
}

// SendKeys delivers a literal string to the pane (no Enter).
func (s *Session) SendKeys(input string) error {
	if input == "" {
		return nil
	}
	return exec.Command("tmux", "send-keys", "-t", s.target(), "-l", "--", input).Run()
}

// SendLine sends `input` followed by Enter.
func (s *Session) SendLine(input string) error {
	if input != "" {
		if err := s.SendKeys(input); err != nil {
			return err
		}
	}
	return s.SendSpecial("Enter")
}

// SendSpecial sends named keys like "Enter", "C-c", "Up", "Escape", etc.
func (s *Session) SendSpecial(keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	args := append([]string{"send-keys", "-t", s.target()}, keys...)
	return exec.Command("tmux", args...).Run()
}

// Interrupt sends Ctrl+C.
func (s *Session) Interrupt() error { return s.SendSpecial("C-c") }

// CaptureOpts controls CapturePane.
type CaptureOpts struct {
	WithEscapes       bool
	IncludeScrollback bool
}

// CapturePane returns the current contents of the backend pane.
func (s *Session) CapturePane(opts CaptureOpts) (string, error) {
	args := []string{"capture-pane", "-p", "-t", s.target()}
	if opts.WithEscapes {
		args = append(args, "-e")
	}
	if opts.IncludeScrollback {
		args = append(args, "-S", "-")
	}
	args = append(args, "-J")

	cmd := exec.Command("tmux", args...)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("tmux capture-pane: %w (stderr=%s)", err, stderr.String())
	}
	return out.String(), nil
}

// PanePID returns the shell PID of the session's pane.
func (s *Session) PanePID() (int, error) {
	cmd := exec.Command("tmux", "display-message", "-p", "-t", s.target(), "#{pane_pid}")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(out.String()))
}
