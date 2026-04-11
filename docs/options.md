# Options

## CLI commands

### `claudraband [options] <prompt...>`

Starts a new session and sends a prompt, unless `-s/--session` is used to target an existing session.

### `claudraband -s <id> <prompt...>`

Resumes an existing session and sends another prompt.

### `claudraband -s <id> -i`

Reconnects to an existing session in interactive REPL mode.

### `claudraband -s <id> --select <n>`

Answers a pending question in a live session by selecting option `n`.

### `claudraband sessions`

Lists tracked sessions from the canonical registry in `~/.claudraband/`. Use `--cwd <dir>` to filter by working directory.

### `claudraband sessions close <id>`

Stops a live local session by session ID.

### `claudraband sessions close --all`

Stops every live tracked session, regardless of backend.

### `claudraband sessions close --cwd <dir>`

Stops all live tracked sessions for the given cwd.

### `claudraband --acp`

Runs `claudraband` as an ACP server over stdio.

### `claudraband serve [--port <n>]`

Starts the daemon used for persistent headless `xterm` sessions.

## CLI flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-h`, `--help` | flag | `false` | Show help |
| `-s`, `--session <id>` | string | empty | Target an existing session |
| `-i`, `--interactive` | flag | `false` | Run REPL mode |
| `--select <n>` | string | empty | Auto-select option `n` for a pending question; requires `--session` |
| `--all` | flag | `false` | Close every live tracked session for `sessions close` |
| `--acp` | flag | `false` | Run as ACP server over stdio |
| `--cwd <dir>` | string | current working directory | Working directory for new/resumed sessions |
| `-c`, `--claude <flags>` | string | empty | Claude CLI flags passed through after parsing known model and permission flags |
| `--terminal-backend <backend>` | `auto \| tmux \| xterm` | `auto` | Select terminal backend |
| `--server <host:port>` | string | empty | Connect to a running daemon instead of starting a local session |
| `--port <n>` | integer | `7842` | Port for `serve` |
| `--debug` | flag | `false` | Emit debug logging |

## Terminal backends

| Backend | Behavior |
|---------|----------|
| `auto` | Prefer `tmux`; fall back to headless `xterm` |
| `tmux` | Runs Claude Code inside a shared local tmux session |
| `xterm` | Runs Claude Code in a headless PTY-backed terminal |

## Permission modes

`claudraband` passes Claude permission settings through from `--claude`, and also surfaces the modes in ACP and daemon-backed workflows.

| Mode | Description |
|------|-------------|
| `default` | Ask before tool use |
| `plan` | Plan-only mode; no edits |
| `auto` | Bypass permission checks |
| `acceptEdits` | Auto-accept file edits |
| `dontAsk` | Skip all confirmations |
| `bypassPermissions` | Dangerous full bypass |

## Model options

| Model | Description |
|-------|-------------|
| `haiku` | Fast and lightweight |
| `sonnet` | Balanced speed and intelligence |
| `opus` | Most capable |

## Daemon behavior

### `serve`

The daemon keeps sessions alive in-process and records them in the same `~/.claudraband/` registry as local sessions. It defaults to `xterm` unless `--terminal-backend` is explicitly provided.

### `--server <host:port>`

Client mode forwards the normal CLI workflow to the daemon:

- create session
- resume session
- stream events
- answer pending permission requests
- check whether a pending question still exists

When `--select` is used against the daemon, the target session must still be live there.

## Library surface

The main library entry point is `claudraband-core`.

### `createClaudraband(options?)`

Creates a runtime with these top-level options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cwd` | string | process cwd | Working directory |
| `claudeArgs` | string[] | `[]` | Raw Claude CLI flags |
| `model` | string | `"sonnet"` | Default Claude model |
| `permissionMode` | permission mode | `"default"` | Default permission mode |
| `allowTextResponses` | bool | `false` | Allow free-text answers to permission requests |
| `terminalBackend` | backend | `auto` | Terminal backend selection |
| `paneWidth` | number | `120` | Terminal width |
| `paneHeight` | number | `40` | Terminal height |
| `logger` | logger | noop logger | Structured logging hooks |
| `onPermissionRequest` | async callback | unset | Intercept and answer permission requests |

### Runtime methods

| Method | Description |
|--------|-------------|
| `startSession(options?)` | Start a new Claude Code session |
| `resumeSession(sessionId, options?)` | Resume an existing Claude session ID |
| `listSessions(cwd?)` | Read tracked sessions from the canonical registry |
| `inspectSession(sessionId, cwd?)` | Inspect one tracked session record |
| `closeSession(sessionId)` | Close a tracked live session through its recorded owner |
| `replaySession(sessionId, cwd)` | Replay parsed event history from a session transcript |

### Session methods

| Method | Description |
|--------|-------------|
| `events()` | Async event stream |
| `prompt(text)` | Send a prompt and wait for turn completion |
| `awaitTurn()` | Wait for the current turn to finish |
| `send(text)` | Send raw text directly |
| `interrupt()` | Interrupt the current Claude turn |
| `stop()` | Stop the session process |
| `detach()` | Disconnect without killing the process |
| `isProcessAlive()` | Check whether the underlying process is still alive |
| `capturePane()` | Capture the current terminal contents |
| `setModel(model)` | Restart the wrapper with a new model |
| `setPermissionMode(mode)` | Restart the wrapper with a new permission mode |

## Operational notes

- `tmux` gives the best local persistence because the real Claude process stays attached to a live terminal pane.
- Local `xterm` mode is not enough for reconnectable blocked prompts unless a daemon is keeping the process alive.
- Local `xterm` without `tmux` or `serve` requires dangerous permission settings because there is no safe way to answer native Claude permission prompts in that mode.
