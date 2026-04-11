# claudraband

`claudraband` is a local wrapper around the official `claude` CLI.

It does not replace Claude Code or bypass it. It just gives you other ways to drive the real local Claude Code session: a direct CLI, `--acp` for editor integrations, and `serve` for persistent headless `xterm` sessions.

## Examples

### Toad

![Toad driving Claude Code](assets/toad-example.png)

*Using [toad](https://github.com/batrachianai/toad) as the TUI while claudraband drives the real Claude Code session underneath.*

### Self-interrogate

![Self interrogation example](assets/self-interrogate.png)

*Claude session IDs can be tied to commits, then resumed later so Claude can explain why it made a change. Useful for Claude itself, Codex, or any other harness that wants the original session context back.*

### Zed

![Zed driving Claude Code through claudraband](assets/zed-example.png)

*Same idea as the toad setup, but inside Zed through ACP.*

## Quick Start

```sh
# build
make build

# ask Claude something
node packages/claudraband-cli/dist/bin.js "audit the last commit"

# interactive mode
node packages/claudraband-cli/dist/bin.js -i

# list sessions
node packages/claudraband-cli/dist/bin.js sessions

# resume a session
node packages/claudraband-cli/dist/bin.js -s <session-id> "continue from there"

# answer a deferred prompt in a live session
node packages/claudraband-cli/dist/bin.js -s <session-id> --select 1

# ACP mode
node packages/claudraband-cli/dist/bin.js --acp

# daemon for persistent xterm sessions
node packages/claudraband-cli/dist/bin.js serve --port 7842
node packages/claudraband-cli/dist/bin.js --server localhost:7842 "hello"
```

For published usage:

```sh
npx claudraband --help
npx claudraband --acp
bunx claudraband --help
bunx claudraband --acp
```

## Packages

- `claudraband-core`: TypeScript library for starting, resuming, replaying, prompting, and interrupting real Claude Code sessions
- `claudraband`: the CLI package, with direct terminal mode, `--acp`, and `serve`

## Backends

- `tmux`: persistent local sessions
- `xterm`: headless PTY-backed sessions
- `auto`: prefer `tmux`, fall back to `xterm`

`xterm` uses:

- `Bun.Terminal` under Bun
- `node-pty` under Node

## Session Behavior

- CLI + `tmux`: sessions stay alive as long as the tmux window stays alive. If the shared tmux session does not exist yet, claudraband creates it.
- CLI + local `xterm`: sessions are not persistent. Resume works by starting `claude --resume <id>`, so blocked interactive state is not preserved.
- CLI + `--server`: the daemon keeps `xterm` sessions alive, so you can reconnect later and answer deferred prompts.
- ACP + `tmux`: sessions survive ACP disconnect because claudraband detaches instead of stopping them.
- ACP + local `xterm`: sessions only live as long as the ACP process does.

One important restriction:

- local `xterm` without `tmux` or `--server` requires dangerous permission settings such as `-c "--dangerously-skip-permissions"` or `-c "--permission-mode bypassPermissions"`

## Why This Exists

- Use Claude Code from other frontends like Toad or Zed
- Keep resumable Claude sessions in custom workflows
- Let other harnesses ask an existing Claude session what it was doing

## Build

```sh
make build
```

Build output:

- `packages/claudraband-core/dist/index.js`
- `packages/claudraband-cli/dist/bin.js`
