package wrap

import "context"

// Wrapper is the interface every backend wrapper must implement. The allagent
// TUI interacts exclusively through this interface -- it never sees the
// backend's raw TUI output.
type Wrapper interface {
	// Name returns the backend identifier ("claude").
	Name() string
	// Model returns the model string passed to the backend.
	Model() string
	// Start launches the backend and begins emitting events.
	Start(ctx context.Context) error
	// Stop gracefully shuts down the backend.
	Stop() error
	// Send delivers a user message to the backend.
	Send(input string) error
	// Interrupt sends Ctrl-C to the backend.
	Interrupt() error
	// Alive reports whether the backend process is still running.
	Alive() bool
	// Events returns the channel of structured session events. Closed when
	// the backend stops.
	Events() <-chan Event
}
