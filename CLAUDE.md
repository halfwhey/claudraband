# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
bun run build       # compile standalone binary -> ./allagent
bun test            # run all tests
bun run typecheck   # tsc --noEmit
bun run run         # run with default model (sonnet)

# Run a single test file
bun test src/clients/claude/parser.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "Tailer"
```

## Architecture

allagent is an ACP (Agent Client Protocol) agent server that wraps Claude Code. An ACP client (e.g. Zed) launches allagent as a subprocess and communicates via stdio JSON-RPC. allagent spawns Claude Code in a hidden tmux session and translates between ACP and Claude's JSONL event stream.

Two layers:

**Layer 1 -- Reusable wrapper packages (`src/`)**

- `src/wrap` defines the `Wrapper` interface and `Event` types. This is the contract between backends and any consumer.
- `src/clients/claude` implements `Wrapper`. It spawns Claude in tmux via `src/tmuxctl`, then tails the on-disk JSONL session file to emit structured `Event`s via an async generator.
- `src/tmuxctl` wraps tmux CLI operations (new-session, send-keys, capture-pane, kill-session).

**Layer 2 -- ACP bridge (`src/acpbridge/`)**

- `src/acpbridge` implements `acp.Agent` from `@agentclientprotocol/sdk`. It bridges ACP JSON-RPC to `wrap.Wrapper`: translating `session/prompt` into `Wrapper.send()`, and streaming `wrap.Event`s back as `session/update` notifications.
- `src/internal/config` is a factory that constructs a Claude `Wrapper`.

**Key data flow:** ACP client -> `session/prompt` (stdin JSON-RPC) -> `Wrapper.send()` -> tmux send-keys -> Claude CLI processes it -> writes JSONL to disk -> tailer parses it -> `Event` from async generator -> bridge translates to ACP `session/update` -> stdout JSON-RPC -> ACP client renders.

## JSONL Session File Format

**Claude Code:** `~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl` -- one JSON object per line. Key `type` values: `"user"`, `"assistant"`, `"system"`, `"progress"`, `"attachment"`, `"permission-mode"`. Messages live in the `message` field with `role` and `content` (string or array of content blocks: text, thinking, tool_use, tool_result).

## Important Patterns

The `Tailer` creates its async generator eagerly in the constructor and starts polling in the background. This avoids a race where consumers call `events()` before the tailer is ready.

Tailers use poll-based tailing (200ms intervals) rather than fsnotify, since the JSONL files are append-only and poll is simpler and more reliable across filesystems.

tmux sessions are named `allagent-<session-id>`. Each ACP session gets its own tmux session to support concurrent sessions.

Turn completion detection uses an idle timer: after receiving assistant text with no pending tool calls, if no new events arrive within 3 seconds, the turn is considered complete.
