# allagent

A Go TUI that wraps Claude Code behind a simpler conversation interface. Claude runs as a hidden engine in a tmux session while you interact through allagent's own conversation view with tool-call introspection and history.

## Requirements

- Go 1.26+
- tmux 3.x
- `claude` CLI (for Claude Code backend)

## Build

```sh
make build
```

## Usage

```sh
# Claude Code (default: haiku model)
./allagent --backend claude

# Override model
./allagent --backend claude --model sonnet

# Set working directory
./allagent --backend claude --workdir /path/to/project
```

## Keybindings

| Key            | Action              |
|----------------|---------------------|
| `Enter`        | Send message        |
| `Ctrl+Q`       | Quit                |
| `Ctrl+X`       | Interrupt (Ctrl+C)  |
| `Ctrl+T`       | Toggle tools panel  |
| `Tab`          | Cycle focus         |
| `Esc`          | Back to input       |
| `Ctrl+Up/Down` | Scroll conversation |
| `Ctrl+U/D`     | Page up/down        |

## Architecture

```
pkg/wrap/              Wrapper interface + Event types
pkg/clients/claude/    Claude Code client (tmux + JSONL tailer)
pkg/tmuxctl/           tmux session primitives

internal/tui/          Bubble Tea TUI (conversation view, tool panel, input)
internal/config/       Config + wrapper construction
main.go                CLI entry point
```

The wrapper package (`pkg/clients/claude`) is the reusable layer. It:
1. Spawns its CLI in a detached tmux session
2. Tails the on-disk JSONL session file for structured events
3. Exposes a `wrap.Wrapper` interface: Send, Interrupt, Events, Alive

The TUI (`internal/tui/`) consumes the Wrapper and renders a conversation from the event stream. The backend's raw TUI is never displayed.
