---
name: claudraband
description: Use claudraband CLI and daemon workflows programmatically to send prompts, resume sessions, inspect status, and manage live session state. Use when running, scripting, or automating Claude Code via claudraband/`cband`, including startup prompt handling, `--connect` daemon mode, and ACP sessions.
---

# Claudraband CLI

`claudraband` wraps Claude Code in a controlled terminal workflow for persistent sessions.

The package also installs `cband` as a shorthand alias.

Local built binary: `node packages/claudraband-cli/dist/bin.js` or `bun packages/claudraband-cli/dist/bin.js`

Published binary: `cband` via `npx @halfwhey/claudraband` or `bunx @halfwhey/claudraband`

---

## Commands

### Start prompt (default)

```bash
cband "review this diff"
# equivalent to: cband prompt
```

### Send a prompt to a session

```bash
cband prompt [--session <id>] [--select <choice>] [--connect <host:port>] <text...>
```

- Without `--session`, starts a new session.
- With `--session`, resumes a saved session.
- With `--select`, answers a pending permission/prompt flow before continuing.
- `--select` and startup handling are documented under "Prompt and send flags" below.

### Send input without waiting

```bash
cband send --session <id> [--select <choice>] <text...>
```

Returns immediately after delivery.

### Stream events

```bash
cband watch --session <id> [--pretty] [--no-follow]
```

### Interrupt a live turn

```bash
cband interrupt --session <id>
```

### Inspect and monitor

```bash
cband status --session <id> [--json]
cband last --session <id> [--json]
```

### Attach to a live session

```bash
cband attach <session-id>
```

### List and close tracked sessions

```bash
cband sessions [--cwd <dir>]
cband sessions close <session-id>
cband sessions close --cwd <dir>
cband sessions close --all
```

### Daemon mode

```bash
cband serve [--host 127.0.0.1] [--port 7842]
# create new daemon sessions via:
cband --connect localhost:7842 "start a migration plan"
```

### ACP

```bash
cband acp [--model opus]
```

`cband acp` runs claudraband as an ACP stdio server.

---

## Common flags

- `--session <id>` — resume (`prompt`, `send`) or target (`watch`, `interrupt`, `status`, `last`) a session
- `--cwd <dir>` — working directory filter for new sessions and `sessions`
- `--model <model>` — `haiku`, `sonnet`, or `opus`
- `--permission-mode <mode>` — `default`, `plan`, `auto`, `acceptEdits`, `dontAsk`, `bypassPermissions`
- `--auto-accept-startup-prompts` — auto-resolve startup prompts (trust-folder / bypass-permissions)
- `--backend <auto|tmux|xterm>` — xterm is still experimental
- `-c, --claude "<flags>"` — passthrough Claude flags
- `--json` — JSON output for `status`, `last`, `watch`
- `--pretty` — human-readable `watch` output
- `--no-follow` — exit after next `turn_end` for live sessions
- `--connect <host:port>` — route *new* sessions through daemon
- `--select <choice>` — answer a pending question/permission prompt on a session

---

## Prompt/select behavior

`--select` is supported on `prompt` and `send` only.

- Use with `--session <id>`.
- Values are Claude raw option numbers.
- If a selected option expects free text, pass it after `--select`:

```bash
cband prompt --session <id> --select 3 "new direction"
```

If a new session hits a startup permission question it will print the session id and then wait for a follow-up `--select` unless `--auto-accept-startup-prompts` is enabled.

---

## Gotchas

- `prompt --select` waits for the turn after selection; `send --select` is fire-and-forget.
- `sessions` lists only live tracked sessions from `~/.claudraband/`.
- `attach` and `--select` require a live tracked session.
- Prefer local usage with `tmux` for reliability; `xterm` remains experimental.
