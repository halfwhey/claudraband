# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
make build          # build library + binaries -> ./dist/claudraband ./claudraband-acp ./claudraband
make build-lib      # build library bundle -> ./dist/claudraband
make build-acp      # compile ACP adapter -> ./claudraband-acp
make build-cli      # compile CLI -> ./claudraband
make test           # run all tests
make typecheck      # typecheck both packages

# Run a single test file
bun test packages/claudraband/src/claude/parser.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "Tailer"
```

## Monorepo Structure

Bun workspaces monorepo with three packages:

- `packages/claudraband/` -- TypeScript library for controlling Claude Code
- `packages/claudraband-acp/` -- ACP adapter wrapping the library (binary: `claudraband-acp`)
- `packages/claudraband-cli/` -- First-party CLI built on the library (binary: `claudraband`)

The main product surface is the library. The ACP package and CLI are adapters layered on top.

## Architecture

### Library (`packages/claudraband/`)

Controls Claude Code directly. It spawns Claude in tmux, tails Claude's JSONL session log, exposes typed events, supports session listing/resume/replay, and normalizes permission requests into a callback interface.

Key pieces:

- `src/claude` implements Claude process/session control and JSONL parsing.
- `src/tmuxctl` wraps tmux CLI operations.
- `src/wrap` contains low-level event and wrapper types used internally.
- `src/index.ts` exposes the public session-first API.

### ACP Adapter (`packages/claudraband-acp/`)

Wraps the `claudraband` library as an ACP agent. An ACP client launches `claudraband-acp` as a subprocess and communicates over stdio JSON-RPC.

- `src/acpbridge` translates library events, sessions, and permission requests into ACP.
- `src/main.ts` is the ACP server entry point.

### CLI (`packages/claudraband-cli/`)

Direct first-party terminal client built on the library.

- `src/args.ts` -- command parsing
- `src/client.ts` -- permission callback UX
- `src/render.ts` -- ANSI terminal renderer for library events
- `src/main.ts` -- entry point, dispatch, REPL loop

## JSONL Session File Format

**Claude Code:** `~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl` -- one JSON object per line. Key `type` values: `"user"`, `"assistant"`, `"system"`, `"progress"`, `"attachment"`, `"permission-mode"`. Messages live in the `message` field with `role` and `content` (string or array of content blocks: text, thinking, tool_use, tool_result).

## Important Patterns

The `Tailer` creates its async generator eagerly in the constructor and starts polling in the background. This avoids a race where consumers call `events()` before the tailer is ready.

Tailers use poll-based tailing (200ms intervals) rather than fsnotify, since the JSONL files are append-only and poll is simpler and more reliable across filesystems.

tmux sessions are named `claudraband-<session-id>`. Each ACP session gets its own tmux session to support concurrent sessions.

Turn completion detection uses an idle timer: after receiving assistant text with no pending tool calls, if no new events arrive within 3 seconds, the turn is considered complete.
