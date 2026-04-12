<div align="center">

# Claudraband

Claude Code for the power user

> Experimental: this project is still evolving as Claude Code and ACP clients change.

[CLI](docs/cli.md) •
[Library](docs/library.md) •
[Daemon API](docs/daemon-api.md) •
[Examples](examples/)

</div>

`claudraband` wraps the official Claude Code TUI in a controlled terminal so you can keep sessions alive, resume them later, answer pending prompts, expose them through a daemon, or drive them through ACP.

It provides:

- Resumable non-interactive workflows. Essentially `claude -p` with session support: `cband continue <session-id> 'what was the result of the research?'`
- An HTTP daemon for remote or headless session control
- An ACP server for editor and alternate frontend integration
- A TypeScript library for building these workflows into your own tools

Caveats

- This is not a replacement for the Claude SDK. It is geared toward personal, ad-hoc usage.
- We do not touch OAuth and we do not bypass the Claude Code TUI. You must authenticate through Claude Code, and every interaction runs through a real Claude Code session.


## Setup

Requirements:

- Node.js or Bun
- An already authenticated Claude Code
- `tmux` for the first-class local and daemon-backed workflow

Install or run:

```sh
# one-off
npx @halfwhey/claudraband "review the staged diff"
bunx @halfwhey/claudraband "review the staged diff"

# install once
npm install -g @halfwhey/claudraband
```

The package installs both `claudraband` and `cband`. `cband` is the recommended shorthand. The package bundles Claude Code `@anthropic-ai/claude-code@2.1.96`; set `CLAUDRABAND_CLAUDE_PATH` if you need to override the binary.

## Quick Start

The two first-class paths are local `tmux` sessions and daemon-backed sessions.

### Local persistent sessions

```sh
cband "audit the last commit and tell me what looks risky"
cband sessions
cband continue <session-id> "keep going"
cband continue <session-id> --select 2
```

### Daemon-backed sessions

```sh
cband serve --host 127.0.0.1 --port 7842
cband --connect localhost:7842 "start a migration plan"
cband attach <session-id>
cband continue <session-id> --select 2
```

The daemon defaults to using `tmux` as the terminal runtime, just like the local path. Use `--connect` only when creating a new daemon-backed session; after that, tracked `continue`, `attach`, and `sessions` route through the recorded live owner automatically.

## Experimental Xterm Backend

`--backend xterm` exists for local or daemon use, but it is experimental and slower than `tmux`. Use it when you need a headless fallback, not as the default path for long-lived interactive work. See [docs/cli.md](docs/cli.md) for current caveats and backend behavior.

## ACP

Use ACP when another tool wants to drive Claude through `claudraband`.

```sh
cband acp --model opus

# example: toad
uvx --from batrachian-toad toad acp 'cband acp -c "--model haiku"'
```

Editor and ACP client support varies by frontend, but `claudraband` itself supports session follow and resume through ACP.

## Session Model

Live sessions are tracked in `~/.claudraband/`.

- `cband sessions` lists live tracked sessions
- `continue` can resume an existing Claude Code session even when it is no longer live
- `attach` only works on live sessions
- `sessions close ...` closes live tracked sessions, either local or daemon-backed

## Examples

### Self-interrogation

Claude can interrogate an older Claude session and justify the choices it made.

![Claude interrogating an older Claude session through claudraband](assets/self-interrogate.png)

### Toad via ACP

Toad can use `claudraband acp` as an alternative frontend for Claude Code.

![Toad using claudraband ACP as an alternative frontend](assets/toad-acp.png)

That UI is still backed by a real Claude Code pane underneath.

![Backing Claude Code pane for the Toad ACP session](assets/toad-claude-pane.png)

### Zed via ACP

Zed can also use `claudraband acp` as an alternative frontend.

![Zed using claudraband ACP as an alternative frontend](assets/zed-acp.png)

## Library

Runnable TypeScript examples live in [`examples/`](examples/):

- [`examples/code-review.ts`](examples/code-review.ts)
- [`examples/multi-session.ts`](examples/multi-session.ts)
- [`examples/session-journal.ts`](examples/session-journal.ts)

For the full API, see [docs/library.md](docs/library.md). For CLI details, see [docs/cli.md](docs/cli.md). For raw daemon endpoints, see [docs/daemon-api.md](docs/daemon-api.md).

## Cheat Sheet

```sh
# install or run once
npx @halfwhey/claudraband "review the staged diff"
bunx @halfwhey/claudraband "review the staged diff"
npm install -g @halfwhey/claudraband

# local persistent sessions
cband "audit the last commit"
cband sessions 
cband sessions close --all # close all claudraband controlled sessions
cband continue <session-id> "keep going"

# answer pending prompts
cband continue <session-id> --select 2
cband continue <session-id> --select 3 "xyz"

# daemon mode
cband serve --host 127.0.0.1 --port 7842
cband --connect localhost:7842 "start a migration plan"
cband attach <session-id>

# ACP
cband acp --model opus
```
