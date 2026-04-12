# CLI reference

`claudraband` has one user model:

- start work
- continue tracked work
- attach to live work
- answer a pending question with `--select`
- inspect or close tracked sessions

Live sessions live in `~/.claudraband/`. Existing live sessions route through that registry automatically. Historical transcripts can still be resumed or inspected when the command needs them, but `sessions` only lists live entries.

`claudraband` runs against bundled Claude Code `@anthropic-ai/claude-code@2.1.96` by default. For advanced override cases, set `CLAUDRABAND_CLAUDE_PATH`.

The package also installs `cband` as a shorthand alias for the same CLI.

## Commands

### `claudraband [options] <prompt...>`

Start a new session and send a prompt.

### `claudraband continue <session-id> [options] <prompt...>`

Resume a tracked session and send another prompt.

If the recorded owner is a live daemon, `claudraband` reconnects there automatically. If the daemon is gone, `claudraband` resumes the Claude session locally.

### `claudraband continue <session-id> --select <choice> [text]`

Answer a pending `AskUserQuestion` or permission prompt in a live session.

If the selected choice is a text-entry option, pass the response text after the choice:

```sh
claudraband continue abc-123 --select 3 "xyz"
```

If you want to cancel the pending prompt and then continue with fresh text, use:

```sh
claudraband continue abc-123 --select 0 "new direction"
```

### `claudraband attach <session-id>`

Open a simple REPL against a live session.

This does not reattach the original terminal UI. It just gives you an interactive
way to keep talking to an already-live session, which is especially useful for
daemon-hosted sessions.

This does not restart dead sessions. Use `continue` for that.

### `claudraband sessions`

List live tracked sessions from `~/.claudraband/`.

Use `--cwd <dir>` to filter by working directory.

### `claudraband sessions close <session-id>`

Close one live tracked session.

### `claudraband sessions close --cwd <dir>`

Close all live tracked sessions for one working directory.

### `claudraband sessions close --all`

Close every live tracked session.

### `claudraband serve [options]`

Run the persistent daemon for headless sessions.

The daemon defaults to `tmux`. `xterm` is still available, but it is currently experimental.

For the raw HTTP reference, see [docs/daemon-api.md](daemon-api.md).

Use `--connect <host:port>` with the top-level prompt command when you want to create a new session there:

```sh
claudraband --connect localhost:7842 "start a headless refactor"
```

### `claudraband acp [options]`

Run `claudraband` as an ACP server over stdio.

## Common flags

| Flag | Description |
|---|---|
| `-h`, `--help` | Show contextual help for the current command |
| `--cwd <dir>` | Working directory for new sessions, or filter for `sessions` |
| `--model <model>` | `haiku`, `sonnet`, or `opus` |
| `--permission-mode <mode>` | Claude permission mode |
| `--backend <backend>` | `auto`, `tmux`, or `xterm` |
| `-c`, `--claude <flags>` | Advanced Claude CLI passthrough flags |
| `--debug` | Show debug logging |

## Command-specific flags

### Prompt / continue

| Flag | Description |
|---|---|
| `--connect <host:port>` | Start a new session on a running daemon. Only valid for new prompts. |
| `--select <choice>` | Answer a pending question in a live tracked session |

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
- `attach` and `continue --select` require a live tracked session.
