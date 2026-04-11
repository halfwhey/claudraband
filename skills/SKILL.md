---
name: claudraband
description: Use claudraband CLI to control Claude Code sessions programmatically. Use when running, scripting, or automating Claude Code via the claudraband CLI — sending prompts, listing/resuming sessions, or working in interactive REPL mode. Triggers on any mention of claudraband, claudraband-cli, ./claudraband, or automating Claude Code sessions. Used when you need to ask youeself (Claude) a question
---

# Claudraband CLI

Claudraband spawns Claude Code in a hidden tmux session, tails its JSONL log, and provides a clean command-line interface for sending prompts, streaming output, and managing sessions.

Binary: `./claudraband` (or `claudraband` if on PATH after `make build`)

---

## Commands

### Send a prompt

```bash
./claudraband "your prompt here"
```

Positional args after flags are concatenated as the prompt. Blocks until Claude finishes all tool calls, then exits.

### Interactive REPL

```bash
./claudraband -i
```

Starts a read-eval-print loop. Send multiple prompts to the same session without restarting. Exit with `Ctrl+D`, cancel current prompt with `Ctrl+C`.

### List sessions

```bash
./claudraband sessions [--cwd <dir>]
```

Lists resumable sessions for a directory (defaults to `cwd`). Output per line: `<sessionId>  <date>  <title>`.

Sessions are stored at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. A session only appears here if the file is >= 100 bytes.

### Resume a session

```bash
./claudraband resume <sessionId> [prompt...]
```

Resumes a previous session by UUID. Optionally send a new prompt immediately.

---

## Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--help` | `-h` | - | Show usage and exit |
| `--interactive` | `-i` | false | REPL mode |
| `--cwd <dir>` | - | `cwd` | Working directory for session |
| `--model <model>` | - | `sonnet` | Model: `haiku`, `sonnet`, `opus` |
| `--permission-mode <mode>` | - | `default` | See permission modes below |
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

Each session gets a tmux session named `claudraband-<random-id>`. The CLI sends prompts into the tmux pane and tails the JSONL log for events.

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
./claudraband "summarize the last 5 commits"

# Interactive with opus
./claudraband -i --model opus

# Auto-approve all permissions
./claudraband --approve-all --permission-mode auto "run tests and fix failures"

# Resume a session and continue
./claudraband sessions
./claudraband resume 550e8400-e29b-41d4-a716-446655440000 "implement what you planned"

# Different working directory
./claudraband --cwd /path/to/repo "what does this do?"

# Debug mode to trace events
./claudraband --debug "write a function" 2>debug.log
```

---

## Gotchas

- **No prompt and no `-i`** -- exits immediately with an error. Always provide one or the other.
- **Session not in `sessions` list** -- file may be < 100 bytes (e.g. aborted immediately). Check `~/.claude/projects/` directly.
- **`--permission-mode` change mid-session** -- requires restarting the session (Claude Code reloads on mode change). Don't set this after the first prompt if you need consistency.
- **`--terminal-backend xterm`** -- fallback for environments without tmux. Slightly less reliable for long sessions; prefer `tmux` or `auto`.
- **`--approve-all` with non-TTY stdin** -- `--approve-all` takes precedence. Without it, all permissions are denied when stdin is not a TTY (e.g. piped input).
