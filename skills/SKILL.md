---
name: claudraband
description: Use claudraband CLI to control Claude Code sessions programmatically. Use when running, scripting, or automating Claude Code via the claudraband CLI — sending prompts, listing/resuming sessions, or working in interactive REPL mode. Triggers on any mention of claudraband, claudraband-cli, npx claudraband, bunx claudraband, or automating Claude Code sessions. Used when you need to ask yourself (Claude) a question
---

# Claudraband CLI

Claudraband spawns Claude Code in a hidden shared tmux session, tails its JSONL log, and provides a clean command-line interface for sending prompts, streaming output, and managing sessions.

Local built binary: `node packages/claudraband-cli/dist/bin.js` or `bun packages/claudraband-cli/dist/bin.js`

Published binary: `claudraband` via `npx @halfwhey/claudraband` or `bunx @halfwhey/claudraband`

---

## Commands

### Send a prompt

```bash
node packages/claudraband-cli/dist/bin.js "your prompt here"
```

Positional args after flags are concatenated as the prompt. Blocks until Claude finishes all tool calls, then exits.

### Interactive REPL

```bash
node packages/claudraband-cli/dist/bin.js -i
```

Starts a read-eval-print loop. Send multiple prompts to the same session without restarting. Exit with `Ctrl+D`, cancel current prompt with `Ctrl+C`.

### List sessions

```bash
node packages/claudraband-cli/dist/bin.js sessions [--cwd <dir>]
```

Lists resumable sessions for a directory (defaults to `cwd`). Output per line: `<sessionId>  <date>  <title>`.

Sessions are stored at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. A session only appears here if the file is >= 100 bytes.

### Resume a session

```bash
node packages/claudraband-cli/dist/bin.js resume <sessionId> [prompt...]
```

Resumes a previous session by UUID. Optionally send a new prompt immediately.

---

## Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--help` | `-h` | - | Show usage and exit |
| `--interactive` | `-i` | false | REPL mode |
| `--cwd <dir>` | - | `cwd` | Working directory for session |
| `--claude "<flags>"` | `-c` | - | Claude CLI launch flags, e.g. `--model sonnet --effort high` |
| `--approve-all` | - | false | Auto-select first permission option |
| `--terminal-backend <backend>` | - | `auto` | `auto`, `tmux`, or `xterm` |
| `--debug` | - | false | Debug logging to stderr |

### Permission modes

- `default` -- prompt user for each tool call
- `plan` -- plan only, no file edits
- `auto` -- bypass all permission checks
- `acceptEdits` -- auto-accept file edits
- `dontAsk` -- skip all confirmations
- `bypassPermissions` -- dangerously skip everything

---

## Session lifecycle

tmux-backed sessions share a tmux session named `claudraband-working-session`. Each Claude session gets its own tmux window named with the Claude session ID, and the CLI sends prompts into that window's pane while tailing the JSONL log for events.

**Turn completion**: detected via 3-second idle timeout after Claude sends a response with no outstanding tool calls. This is not a hard delay -- the idle timer only starts after a response arrives.

**Interruption**:
- `Ctrl+C` while prompt is running -- sends interrupt to Claude, waits for it to finish
- `Ctrl+C` while idle -- stops session and exits
- `Ctrl+D` in REPL -- exits the loop and stops the session

---

## Permission prompts

When Claude requests a tool permission, the CLI prints:

```
Permission: <title>
  <description>
  1. <option> (<kind>)
  2. <option> (<kind>)
```

With `--approve-all`, the first option is selected automatically and prints `-> auto: <option name>`.

If stdin is not a TTY and `--approve-all` is not set, permission is denied automatically.

**Tool kinds shown in prompts**: `read`, `edit`, `execute`, `search`, `fetch`, `think`, `other`.

---

## Output

Events stream to stdout with ANSI color:

- Grey -- assistant text
- Bold yellow -- tool call: `> ToolName`
- Green -- tool result: `+ ToolName`
- Red -- error: `! message`
- Dimmed -- thinking blocks and system messages

Use `--debug` to send diagnostic logs to stderr without polluting stdout.

---

## Common examples

```bash
# One-shot prompt
node packages/claudraband-cli/dist/bin.js "summarize the last 5 commits"

# Interactive with opus
node packages/claudraband-cli/dist/bin.js -i --claude "--model opus"

# Auto-approve all permissions
node packages/claudraband-cli/dist/bin.js --approve-all --claude "--permission-mode auto" "run tests and fix failures"

# Resume a session and continue
node packages/claudraband-cli/dist/bin.js sessions
node packages/claudraband-cli/dist/bin.js resume 550e8400-e29b-41d4-a716-446655440000 "implement what you planned"

# Different working directory
node packages/claudraband-cli/dist/bin.js --cwd /path/to/repo "what does this do?"

# Debug mode to trace events
node packages/claudraband-cli/dist/bin.js --debug "write a function" 2>debug.log
```

---

## Gotchas

- **No prompt and no `-i`** -- exits immediately with an error. Always provide one or the other.
- **Session not in `sessions` list** -- file may be < 100 bytes (e.g. aborted immediately). Check `~/.claude/projects/` directly.
- **`--claude "--permission-mode ..."` change mid-session** -- requires restarting the session (Claude Code reloads on mode change). Don't change it after the first prompt if you need consistency.
- **`--terminal-backend xterm`** -- fallback for environments without tmux. Slightly less reliable for long sessions; prefer `tmux` or `auto`.
- **`--approve-all` with non-TTY stdin** -- `--approve-all` takes precedence. Without it, all permissions are denied when stdin is not a TTY (e.g. piped input).
