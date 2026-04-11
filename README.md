# claudraband

`claudraband` is a local wrapper around the official `claude` CLI that let's you utilize your Claude Code subscription with an alternative frontend or cli.

- Doesn't replace Claude Code. 
- Doesn't bypass Claude Code.
- Doesn't intercept Oauth tokens.

## Examples

### Toad

![Toad driving Claude Code](assets/toad-example.png)

*Using [toad](https://github.com/batrachianai/toad) as the TUI while claudraband drives the real Claude Code session underneath.*

### Self-interrogate

![Self interrogation example](assets/self-interrogate.png)

*I have hooks that associate Claude session IDs with commits (right pane). Claude can resume itself with claudraband to explain why it made certain decisions. This works as an introspection workflow for Claude itself, Codex, or any other harness that wants to ask the original Claude session what happened.*

### Zed

![Zed driving Claude Code through claudraband](assets/zed-example.png)

*Same idea as the toad setup, but inside the Zed editor through the ACP adapter.*

## Quick Start

```sh
# Build everything
make build

# Ask Claude Code something directly
./claudraband "audit the last commit and tell me what looks risky"

# Start a REPL
./claudraband -i

# List resumable Claude sessions for the current repo
./claudraband sessions

# Resume one later
./claudraband resume <session-id> "continue from where we left off"

# Force the headless backend if you don't want tmux
./claudraband --terminal-backend xterm "review the staged diff"

# Start the ACP adapter
./claudraband-acp --model opus
```


We wrap the full Claue Code TUI in a terminal and drive that terminal.

The repo is split into three packages:

- `claudraband-core`: the TypeScript library for driving the real `claude` CLI
- `claudraband-acp`: an ACP adapter built on top of that library
- `claudraband-cli`: the first-party terminal client built on top of that library

## Features

- `claudraband-core`: reusable TypeScript library for starting, resuming, replaying, prompting, and interrupting Claude Code sessions
- `claudraband-acp`: an ACP server that wraps your local Claude Code install
- `claudraband-cli`: direct first-party CLI for local terminal use
- resumable sessions backed by Claude's real session IDs (which addresses the `claude -p` limitation of not being resumable)
- optional terminal backends:
  - `tmux` for detached terminal sessions 
  - `xterm` for headless PTY-backed sessions

## Why This Exists

You can use:

- Claude Code inside an ACP editor such as `toad` and `zed` (https://agentclientprotocol.com/get-started/clients, session support by the clients are not reliable yet, though claudraband fully supports it).
- Claude Code behind a custom scripting workflow that depends on resumability. 

## Terminal Backends

- `tmux`: runs Claude Code in a detached `tmux` session
- `xterm`: runs Claude Code in a headless terminal session
- `auto`: prefers `tmux` when available, otherwise falls back to `xterm`

The `xterm` backend is runtime-aware:

- under Bun, it uses `Bun.Terminal`
- under Node, it uses `node-pty`
- in both cases it keeps a headless xterm screen model for terminal capture and prompt detection

## Tested on

- `claude` v2.1.96 (Already authenticated)
- Bun 1.3+ for the default local workflow and build scripts
- `tmux` 3.x only if you want the `tmux` backend

## Build

```sh
make build
```

That builds the packages and leaves repo-root launchers in place:

- `./claudraband`
- `./claudraband-acp`

You can also build each package separately:

```sh
make build-lib
make build-acp
make build-cli
```
