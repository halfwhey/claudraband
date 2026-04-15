# CLI reference

`claudraband` has one user model:

- prompt new work
- continue a saved session by passing `--session <id>`
- send input without waiting
- watch a session's event stream
- interrupt an in-progress turn
- inspect or close tracked sessions

Live sessions live in `~/.claudraband/`. Existing live sessions route through that registry automatically. Historical transcripts can still be resumed or inspected when the command needs them, but `sessions` only lists live entries.

`claudraband` runs against bundled Claude Code `@anthropic-ai/claude-code@2.1.96` by default. For advanced override cases, set `CLAUDRABAND_CLAUDE_PATH`.

The package also installs `cband` as a shorthand alias for the same CLI.

## Commands

### `cband [options] <prompt...>`

Start a new session and send a prompt. This is shorthand for `cband prompt`.

### `cband prompt [--session <id>] [--select <choice>] <prompt...>`

Send a prompt and wait for Claude to finish its turn.

- Without `--session`, a new session is created.
- With `--session <id>`, the saved session is auto-resumed. If the id has no saved transcript, the command errors with `session not found`.
- With `--select <choice>`, answers a pending `AskUserQuestion` or permission prompt, then returns the turn that follows. If the selected option accepts free text, pass it as the trailing prompt argument.

Examples:

```sh
cband prompt "review the staged diff"
cband prompt --session abc-123 "keep going"
cband prompt --session abc-123 --select 2
cband prompt --session abc-123 --select 3 "xyz"
cband prompt --session abc-123 --select 3 "new direction"
```

### `cband send [--session <id>] [--select <choice>] <text...>`

Send input without waiting for a turn to complete. Returns as soon as the input is delivered. Use `watch`, `status`, or `last` to observe the response.

- `--session <id>` auto-resumes the saved session (errors if missing).
- `--select <choice>` fires a pending-answer selection. If the selected option accepts free text, pass it as the trailing argument.

Examples:

```sh
cband send --session abc-123 "quick note"
cband send --session abc-123 --select 2
cband send --session abc-123 --select 3 "new direction"
```

### `cband watch --session <id> [--pretty] [--no-follow]`

Stream events from a session. When a daemon owns the session this connects to the SSE stream; otherwise it replays the local transcript. One event per line as JSON by default.

For daemon-backed sessions, `watch` is mainly the streaming companion to `send`. `prompt` already waits for the turn and prints the completed assistant response directly.

- `--pretty` renders events as human-readable text.
- `--no-follow` exits after the next `turn_end`.

### `cband interrupt --session <id>`

Cancel the in-progress turn on a live session (equivalent to sending Ctrl-C inside Claude).

### `cband status --session <id> [--json]`

Show status and metadata for a session, including whether a turn is in progress and whether input is pending.

- `--json` emits the same payload the daemon returns.

Positional form `cband status <session-id>` is also accepted.

### `cband last --session <id> [--json]`

Print the last complete assistant turn from a session's transcript. Exits with status 1 if no completed turn is available.

- `--json` emits `{ sessionId, cwd, text }` as JSON.

Positional form `cband last <session-id>` is also accepted.

### `cband attach <session-id>`

Open a simple REPL against a live session.

This does not reattach the original terminal UI. It just gives you an interactive way to keep talking to an already-live session, which is especially useful for daemon-hosted sessions. It does not restart dead sessions.

### `cband sessions`

List live tracked sessions from `~/.claudraband/`.

Use `--cwd <dir>` to filter by working directory.

### `cband sessions close <session-id>`

Close one live tracked session.

### `cband sessions close --cwd <dir>`

Close all live tracked sessions for one working directory.

### `cband sessions close --all`

Close every live tracked session.

### `cband serve [options]`

Run the persistent daemon for headless sessions.

The daemon defaults to `tmux`. `xterm` is still available, but it is currently experimental.

For the raw HTTP reference, see [docs/daemon-api.md](daemon-api.md).

Use `--connect <host:port>` with `prompt` or `send` when you want to create a new session on a running daemon:

```sh
cband --connect localhost:7842 "start a headless refactor"
```

### `cband acp [options]`

Run `claudraband` as an ACP server over stdio.

## Common flags

| Flag | Description |
|---|---|
| `-h`, `--help` | Show contextual help for the current command |
| `--session <id>` | Resume (`prompt`, `send`) or target (`watch`, `interrupt`, `status`, `last`) a session |
| `--cwd <dir>` | Working directory for new sessions, or filter for `sessions` |
| `--model <model>` | `haiku`, `sonnet`, or `opus` |
| `--permission-mode <mode>` | Claude permission mode |
| `--backend <backend>` | `auto`, `tmux`, or `xterm` |
| `-c`, `--claude <flags>` | Advanced Claude CLI passthrough flags |
| `--json` | Emit JSON for `status`, `last`, `watch` |
| `--debug` | Show debug logging |

## Command-specific flags

### `prompt` and `send`

| Flag | Description |
|---|---|
| `--session <id>` | Resume the saved session with this id |
| `--select <choice>` | Answer a pending question or permission prompt. If that option expects text, pass it as the trailing argument. Requires `--session`. |
| `--connect <host:port>` | Route the session through a running daemon. Valid for new sessions. |

### `watch`

| Flag | Description |
|---|---|
| `--session <id>` | Target session (required) |
| `--pretty` | Human-readable output instead of JSON lines |
| `--no-follow` | Exit after the next `turn_end` |

### `status` and `last`

| Flag | Description |
|---|---|
| `--session <id>` | Target session |
| `--cwd <dir>` | Disambiguate if the id matches multiple cwds |
| `--json` | Emit JSON payload |

### `sessions`

| Flag | Description |
|---|---|
| `--cwd <dir>` | Filter the session list by working directory |

### `sessions close`

| Flag | Description |
|---|---|
| `--cwd <dir>` | Close all live sessions for one working directory |
| `--all` | Close every live tracked session |

### `serve`

| Flag | Description |
|---|---|
| `--host <addr>` | Host to listen on. Default: `127.0.0.1` |
| `--port <n>` | Port to listen on. Default: `7842` |

## Backends

| Backend | Behavior |
|---|---|
| `auto` | Prefer `tmux`, then fall back to headless `xterm` |
| `tmux` | Run Claude Code inside a shared local tmux session |
| `xterm` | Run Claude Code in a headless PTY-backed terminal. Experimental. |

## Permission modes

| Mode | Description |
|---|---|
| `default` | Ask before tool use |
| `plan` | Plan-only mode; no edits |
| `auto` | Bypass permission checks |
| `acceptEdits` | Auto-accept file edits |
| `dontAsk` | Skip all confirmations |
| `bypassPermissions` | Dangerous full bypass |

## Notes

- `tmux` is the first-class backend for both local sessions and the daemon.
- `xterm` is experimental, both locally and under `serve`, while the backend continues to improve.
- `attach` and `--select` require a live tracked session.
- `prompt --select` waits for the turn that follows the selection. `send --select` is fire-and-forget.
