# allagent

An ACP (Agent Client Protocol) agent server that wraps Claude Code. An ACP client (e.g. Zed) launches allagent as a subprocess and communicates via stdio JSON-RPC. allagent spawns Claude Code in a hidden tmux session and translates between ACP and Claude's JSONL event stream.

## Requirements

- Bun 1.3+
- tmux 3.x
- `claude` CLI (for Claude Code backend)

## Build

```sh
bun run build
```

## Usage

```sh
# Default model (sonnet)
./allagent

# Override model
./allagent --model sonnet

# Enable debug logging
./allagent --debug
```

## Architecture

```
src/wrap/               Wrapper interface + Event types
src/clients/claude/     Claude Code client (tmux + JSONL tailer)
src/tmuxctl/            tmux session primitives
src/acpbridge/          ACP agent bridge (translates wrap.Events to ACP notifications)
src/internal/config/    Config + wrapper construction
src/main.ts             CLI entry point
```

The wrapper package (`src/clients/claude`) is the reusable layer. It:
1. Spawns its CLI in a detached tmux session
2. Tails the on-disk JSONL session file for structured events
3. Exposes a `wrap.Wrapper` interface: Send, Interrupt, Events, Alive

The ACP bridge (`src/acpbridge/`) consumes the Wrapper and translates events into ACP session/update notifications. The backend's raw TUI is never displayed.
