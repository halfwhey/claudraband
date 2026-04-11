# claudraband

Claude Code for apps that were not invited.

`claudraband` is now split into three packages:

- `claudraband`: the TypeScript library for driving the real `claude` CLI
- `claudraband-acp`: an ACP adapter built on top of that library
- `claudraband-cli`: the first-party terminal client built on top of that library

The trick is still the same: we use the real Claude Code process, drive it through a hidden `tmux` session, read Claude's JSONL session log, and expose a cleaner control surface on top.

If the rule is "you can't use Claude Code subscriptions from third-party apps", this is the annoyingly literal response: we are still using Claude Code. We just automated the typing and the reading.

This is a local wrapper, not a hosted Claude replacement. Claude Code is still the process doing the work. You are still responsible for using it in ways you're comfortable with.

## What You Get

- `claudraband`: reusable TypeScript library for starting, resuming, prompting, and interrupting Claude Code sessions
- `claudraband-acp`: an ACP server that wraps your local Claude Code install
- `claudraband-cli`: direct first-party CLI for local terminal use
- resumable sessions backed by Claude's real session IDs
- interactive REPL mode for quick terminal conversations
- session listing and replay for a given working directory
- per-session `tmux` isolation so multiple conversations can run at once
- model and permission mode controls exposed through both the library and ACP

## Why This Exists

Because "just use Claude Code directly" stops being useful the second you want:

- Claude Code inside an ACP editor
- Claude Code behind a custom terminal workflow
- Claude Code sessions you can list, resume, and script
- Claude Code as infrastructure instead of a single full-screen TUI

`claudraband` does not replace Claude Code. It liberates it from its own terminal window.

## Requirements

- Bun 1.3+
- `tmux` 3.x
- `claude` CLI installed and authenticated

## Build

```sh
make build
```

Or build each target separately:

```sh
make build-lib      # -> ./dist/claudraband
make build-acp      # -> ./claudraband-acp
make build-cli      # -> ./claudraband
```

## Quick Start

```sh
# Build both binaries
make build

# Ask Claude Code something directly
./claudraband "audit the last commit and tell me what looks risky"

# Start a REPL
./claudraband -i

# List resumable Claude sessions for the current repo
./claudraband sessions

# Resume one later
./claudraband resume <session-id> "continue from where we left off"

# Use the ACP adapter from an ACP-speaking client
./claudraband-acp --model opus
```

## Cool Things To Demo

### 1. Claude Code inside an ACP client

Point any ACP-speaking tool at `claudraband-acp` and it gets Claude Code without needing native Claude support. If it can spawn an ACP subprocess, it can now "support Claude Code" by accident.

### 2. Scripted repo review from the terminal

```sh
./claudraband "review the staged diff, list the three biggest risks, then draft a commit message"
```

This is useful when you want Claude Code's judgement without living inside Claude Code's UI.

### 3. Long-lived project foreman

Start a session, let Claude inspect the repo, exit, then resume the exact same session later:

```sh
./claudraband -i
./claudraband sessions
./claudraband resume <session-id> "pick up the refactor plan"
```

Because the session is Claude's real session, history survives outside the wrapper process.

### 4. Parallel Claude workers

Each ACP session gets its own hidden `tmux` session. That means you can run multiple Claude Code conversations at once across different repos or different tasks without sharing one giant TUI.

Examples:

- one session reviewing a PR
- one session writing tests
- one session summarizing the codebase for a new teammate

### 5. Permission mode switching from the client side

`claudraband` exposes Claude Code permission modes through ACP, so a client can flip between safer planning and more aggressive execution without manually driving the TUI.

Available modes:

- `default`
- `plan`
- `auto`
- `acceptEdits`
- `dontAsk`
- `bypassPermissions`

### 6. A tiny protocol adapter with disproportionate consequences

The `claudraband` library is the real product surface. `claudraband-acp` is just one adapter on top:

- build your own Claude automation in TypeScript
- reuse session discovery, replay, and permission mediation logic
- prove an ACP client works before wiring it into a UI
- wrap Claude Code for tools that only understand ACP

## How The Trick Works

1. An ACP client launches `claudraband-acp` as a subprocess over stdio JSON-RPC.
2. `claudraband-acp` starts Claude Code in a detached `tmux` session.
3. It watches Claude's on-disk JSONL session file in `~/.claude/projects/...`.
4. It parses Claude events and turns them into ACP `session/update` notifications.
5. The client renders Claude Code like it was a native ACP agent the whole time.

It is not elegant. It is effective.

## Monorepo Layout

```text
packages/claudraband/      reusable Claude Code control library
packages/claudraband-acp/  ACP adapter
packages/claudraband-cli/  first-party terminal client
```

Inside `packages/claudraband/src/`:

```text
claude/                Claude Code wrapper + JSONL parser
tmuxctl/               tmux session primitives
wrap/                  event types and low-level wrapper internals
index.ts               public library API
```

## Development

```sh
make test
make typecheck
```
