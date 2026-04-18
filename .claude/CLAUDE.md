# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
make build          # build library + CLI -> packages/*/dist
make build-lib      # build library bundle -> packages/claudraband-core/dist
make build-cli      # compile CLI -> packages/claudraband-cli/dist/bin.js
make test           # run all tests
make typecheck      # typecheck both packages

# Run a single test file
bun test packages/claudraband-core/src/claude/parser.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "Tailer"
```

## Monorepo Structure

Bun workspaces monorepo with two packages:

- `packages/claudraband-core/` -- TypeScript library for controlling Claude Code (package: `@halfwhey/claudraband-core`)
- `packages/claudraband-cli/` -- First-party CLI built on the library (package + binary: `claudraband`)

The main product surfaces are:

- `@halfwhey/claudraband-core` as the library
- `claudraband` as the published CLI, including `--acp` mode over stdio

## Architecture

### Library (`packages/claudraband-core/`)

Controls Claude Code directly. It spawns Claude in tmux, tails Claude's JSONL session log, exposes typed events, supports session listing/resume/replay, validates Claude account state before startup, and normalizes permission requests into a callback interface.

Key pieces:

- `src/claude` implements Claude process/session control and JSONL parsing.
- `src/tmuxctl` wraps tmux CLI operations.
- `src/wrap` contains low-level event and wrapper types used internally.
- `src/index.ts` exposes the public session-first API.

### CLI (`packages/claudraband-cli/`)

Direct first-party terminal client built on the library. It also exposes ACP server mode via `claudraband --acp`.

- `src/args.ts` -- command parsing
- `src/client.ts` -- permission callback UX
- `src/render.ts` -- ANSI terminal renderer for library events
- `src/acpbridge` -- ACP translation layer
- `src/bin.ts` -- published executable entry point
- `src/main.ts` -- CLI runtime, ACP mode, REPL loop

### Docker

The Docker image uses a mounted account bundle at `/claude-account` and links:

- `/root/.claude -> /claude-account/.claude`
- `/root/.claude.json -> /claude-account/.claude.json`

Expected flow:

1. Run `claude` once with the mount to complete onboarding.
2. Reuse the same mount with `serve`.

`serve` should fail fast when the mounted Claude state is missing onboarding markers or credentials.

## JSONL Session File Format

**Claude Code:** `~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl` -- one JSON object per line. Key `type` values: `"user"`, `"assistant"`, `"system"`, `"progress"`, `"attachment"`, `"permission-mode"`. Messages live in the `message` field with `role` and `content` (string or array of content blocks: text, thinking, tool_use, tool_result).

## Important Patterns

The `Tailer` creates its async generator eagerly in the constructor and starts polling in the background. This avoids a race where consumers call `events()` before the tailer is ready.

Tailers use poll-based tailing (200ms intervals) rather than fsnotify, since the JSONL files are append-only and poll is simpler and more reliable across filesystems.

tmux-backed Claude sessions run inside a shared tmux session named `claudraband-working-session`. Each Claude session gets its own tmux window named after the Claude session UUID so concurrent sessions stay isolated.

Turn completion detection uses an idle timer: after receiving assistant text with no pending tool calls, if no new events arrive within 3 seconds, the turn is considered complete.

Startup-native prompts such as workspace trust and bypass-permissions warnings are parsed from the visible terminal state. By default they surface as `pendingInput: "permission"` and must be answered with `--select` or the daemon `select` field using Claude's raw option numbers. `--auto-accept-startup-prompts` and `autoAcceptStartupPrompts` are the explicit opt-in escape hatches for unattended startup.

## CLI Conventions

- For local built usage, run `node packages/claudraband-cli/dist/bin.js ...` or `bun packages/claudraband-cli/dist/bin.js ...`.
- For published usage, run `npx @halfwhey/claudraband ...` or `bunx @halfwhey/claudraband ...`.
- Claude launch flags are passed through a single option: `--claude "<flags>"`.
- Local wrapper flags such as `--acp`, `--backend`, `--turn-detection`, `--select`, `--auto-accept-startup-prompts`, and `--debug` stay at the claudraband layer.
- `--select` uses Claude's raw native prompt numbering. For the bypass-permissions startup warning, accepting the prompt is `--select 2`, not `--select 1`.
