# Test Cases

End-to-end test cases for claudraband. Each case below requires a real Claude
process or live session state — pure parsing, help, and validation tests are
covered in the unit suite (`packages/claudraband-cli/src/*.test.ts`,
`packages/claudraband-core/src/*.test.ts`) and are not duplicated here.

**Conventions**

- **Always use `--model haiku`** (or `-c '--model haiku'` when passing through). Haiku is the fastest and cheapest model and is the only model these tests are budgeted for. Never run a case here against `sonnet` or `opus`.
- **CLI binary:** `node packages/claudraband-cli/dist/bin.js` (run `make build` first).
- Run the unit suite with `make test` before working through this file.

---

## 1. Top-level flag behavior

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 1.1 | `--cwd` actually changes Claude's working directory | `claudraband --cwd /tmp --model haiku "what directory are you in?"` | Response references `/tmp` |
| 1.2 | `--debug` surfaces session id on stderr | `claudraband --debug --model haiku "say ok"` | stderr contains `session:` |
| 1.3 | `-c` flag passthrough is honored by Claude | `claudraband -c '--model haiku --effort low' "say ok"` | Runs without Claude rejecting the args |

## 2. Local tmux session lifecycle

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 2.1 | New session with prompt | `claudraband --model haiku "say hello world and nothing else"` | Prints hello world, exits cleanly |
| 2.2 | Session appears in list | `claudraband sessions` | Shows the session from 2.1 with `alive=true` |
| 2.3 | Resume session with new prompt | `claudraband prompt --session <id> --model haiku "say goodbye"` | Prints goodbye, auto-resumes existing session |
| 2.4 | Attach to live session | `echo "say hi" \| claudraband attach <id>` | Responds to prompt, exits on EOF |
| 2.5 | Close session by ID | `claudraband sessions close <id>` | Confirms closed |
| 2.6 | Close all sessions | `claudraband sessions close --all` | Closes every live session |
| 2.7 | Close by cwd | `claudraband sessions close --cwd /home/ludvi/Repos/allagent` | Closes sessions for that cwd |
| 2.8 | Session list after close | `claudraband sessions` | No live sessions |
| 2.9 | Close non-existent session | `claudraband sessions close nonexistent-uuid` | Error: not running / not found |
| 2.10 | Close by cwd with no matches | `claudraband sessions close --cwd /nonexistent` | "no live sessions found" |

## 3. Persistent sessions (detach / reattach)

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 3.1 | Session persists after prompt | After 2.1, the tmux window still exists | `claudraband sessions` shows `alive=true` |
| 3.2 | Resume recalls context | `claudraband prompt --session <id> --model haiku "what was my last message?"` | Responds with the prior context |
| 3.3 | Multiple sequential prompts | Three `prompt --session <id>` calls in a row | Each gets a response, session stays alive |

## 4. Select flow (pending questions)

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 4.1 | Trigger AskUserQuestion | `claudraband --model haiku "use the ask user question tool to ask me: red or blue?"` | Defers and exits with the session alive |
| 4.2 | Answer pending question | `claudraband prompt --session <id> --select 1` | Sends selection, gets Claude's response |
| 4.3 | Answer with no pending question | `claudraband prompt --session <id> --select 1` (after 4.2) | Error: "no pending question or permission prompt" |
| 4.4 | Answer on dead session | `claudraband prompt --session <closed-id> --select 1` | Error: "not live" |
| 4.5 | Answer on non-existent session | `claudraband prompt --session nonexistent --select 1` | Error: session not found |
| 4.6 | Fire-and-forget answer via send | `claudraband send --session <id> --select 1` | Selection delivered, returns immediately |
| 4.7 | Free-text answer | `claudraband prompt --session <id> --select 3 "use the blue theme"` | Selection then text delivered, response returned |

For 4.7, the free-text option id depends on the question schema. In the
`red or blue?` example from 4.1, Claude surfaces two explicit options plus a
text-input option, so the free-text choice is `3`.

## 5. Status, last, watch, interrupt

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 5.1 | Status of live session | Start a session, then `claudraband status --session <id>` | `alive    true`, `turnInProgress`, `pendingInput` populated |
| 5.2 | Status of dead session | After closing, `claudraband status --session <id>` | `alive    false` |
| 5.3 | Status JSON | `claudraband status --session <id> --json` | Same payload as `GET /sessions/:id/status` |
| 5.4 | Last of session with history | `claudraband last --session <id>` | Prints the last complete assistant turn |
| 5.5 | Last of session with no completed turn | `claudraband last --session <id-with-no-response>` | Exits 1 with empty stdout |
| 5.6 | Last JSON | `claudraband last --session <id> --json` | Emits `{ sessionId, cwd, text }` |
| 5.7 | Watch streams events | `claudraband watch --session <id>` while `cband send --session <id> "hi"` runs in another shell | One JSON event per line, exits cleanly on Ctrl-C |
| 5.8 | Watch pretty mode | `claudraband watch --session <id> --pretty` | Renders events as human-readable text |
| 5.9 | Watch no-follow | `claudraband watch --session <id> --no-follow` | Exits after the next `turn_end` |
| 5.10 | Interrupt in-progress turn | `claudraband interrupt --session <id>` while a turn is running | Turn aborts, watcher sees the interrupt |
| 5.11 | Interrupt on idle session | `claudraband interrupt --session <id>` (idle) | No-op, exits 0 |

## 6. Daemon server mode

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 6.1 | Start daemon | `claudraband serve --port 17842` | "daemon listening on port 17842" |
| 6.2 | New session via daemon | `claudraband --connect localhost:17842 --model haiku "say hello from daemon"` | Gets response via daemon |
| 6.3 | Daemon session in list | `claudraband sessions` | Shows session from 6.2 |
| 6.4 | Resume daemon session | `claudraband prompt --session <id> --model haiku "still there?"` | Auto-routes through daemon, responds with context |
| 6.5 | Close daemon session | `claudraband sessions close <id>` | Auto-routes through daemon, confirms closed |
| 6.6 | Close all daemon sessions | `claudraband sessions close --all` | Closes daemon + local |
| 6.7 | Daemon sessions after close | `claudraband sessions` | No sessions |
| 6.8 | Stop daemon | SIGINT to the daemon process | Shuts down cleanly |

### 6A. Raw daemon HTTP API

These cases validate the HTTP contract directly, rather than going through the
CLI's owner-routing logic.

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 6A.1 | Create session over HTTP | `curl -fsS -X POST localhost:17842/sessions -H 'content-type: application/json' -d '{"cwd":"/tmp","model":"haiku"}'` | JSON contains `sessionId`, `backend`, `resumed:false` |
| 6A.2 | `/prompt` returns completed response JSON | `curl -fsS -X POST localhost:17842/sessions/<id>/prompt -H 'content-type: application/json' -d '{"text":"say exactly: HTTP_OK"}'` | JSON contains `stopReason:"end_turn"` and `text:"HTTP_OK"` |
| 6A.3 | `/send` is fire-and-forget and pairs with `/watch` | In one shell: `curl -N localhost:17842/sessions/<id>/watch`.<br>In another: `curl -fsS -X POST localhost:17842/sessions/<id>/send -H 'content-type: application/json' -d '{"text":"say exactly: WATCH_OK"}'` | `/send` returns quickly with `{"ok":true}`; watcher receives `assistant_text` and `turn_end` events |
| 6A.4 | `/prompt` without `select` while input is pending returns 409 | Trigger an `AskUserQuestion`, then `curl -i -X POST localhost:17842/sessions/<id>/prompt -H 'content-type: application/json' -d '{"text":"hello"}'` | HTTP 409 with JSON body containing `pendingInput:"question"` |
| 6A.5 | `/status` surfaces pending input | While the session is blocked on a question or permission prompt: `curl -fsS localhost:17842/sessions/<id>/status` | JSON contains `pendingInput:"question"` or `"permission"` |
| 6A.6 | `/last` includes pending input metadata | `curl -fsS localhost:17842/sessions/<id>/last` | JSON contains `sessionId`, `cwd`, `text`, and `pendingInput` |
| 6A.7 | Removed pending/permission endpoints return 404 | `curl -i localhost:17842/sessions/<id>/pending-question` and `curl -i -X POST localhost:17842/sessions/<id>/permission` | Both return HTTP 404 |

## 7. xterm backend (local, no daemon)

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 7.1 | xterm without dangerous perms fails | `claudraband --backend xterm --model haiku "hello"` | Error: "local xterm backend requires dangerous permission settings" |
| 7.2 | xterm with dangerous perms | `claudraband --backend xterm -c '--model haiku --dangerously-skip-permissions' "say hi"` | Works (or errors about a missing dep) |

## 8. Library API (programmatic usage)

| ID | Test | Script | Expected |
|----|------|--------|----------|
| 8.1 | `createClaudraband` + `openSession` + `prompt` | See script below | Gets response text |
| 8.2 | Event streaming | Subscribe to events, verify `AssistantText` received | Events stream correctly |
| 8.3 | Detach + list | Start session, detach, list sessions | Session appears in list |
| 8.4 | Multi-session | Start two sessions concurrently | Both produce output |
| 8.5 | Permission callback | Set default mode, trigger tool use | `onPermissionRequest` fires |

Library script for 8.1:

```typescript
import { createClaudraband, EventKind } from "@halfwhey/claudraband";
const rt = createClaudraband({ model: "haiku", permissionMode: "acceptEdits" });
const s = await rt.openSession({
  cwd: process.cwd(),
  onPermissionRequest: async (r) => ({ outcome: "selected", optionId: r.options[0].optionId }),
});
let text = "";
const pump = (async () => { for await (const e of s.events()) if (e.kind === EventKind.AssistantText) text += e.text; })();
await s.prompt("say exactly: LIBRARY_TEST_OK");
await s.stop();
await pump.catch(() => {});
console.log(text.includes("LIBRARY_TEST_OK") ? "PASS" : "FAIL: " + text);
```

## 9. Examples

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 9.1 | code-review.ts | `bun examples/code-review.ts` | Produces a code review |
| 9.2 | multi-session.ts | `bun examples/multi-session.ts` | Both sessions produce output |
| 9.3 | session-journal.ts | `bun examples/session-journal.ts` (after other tests) | Replays a session |

## 10. Multi-session edge cases

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 10.1 | Concurrent sessions (local) | Run two prompts in parallel | Both complete independently |
| 10.2 | Ambiguous session ID across cwds | `claudraband status --session <id>` where the id exists in multiple cwds | Error: "matched multiple transcript locations. Re-run with --cwd" |

## 11. ACP mode

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 11.1 | ACP starts and responds to initialize | `claudraband acp --model haiku` (send an ACP `initialize` over stdio) | Responds per the ACP protocol |

## 12. Multi-step task across backends and execution modes

A single end-to-end task that exercises file writes, two `bash` tool calls,
and a final formatted report. The same task is run across the four
combinations of `{tmux, xterm} × {local CLI, daemon}` to confirm the wrapper
behaves identically regardless of backend or execution mode. Always uses
`--model haiku`.

**The task.** Ask Claude to:

1. Write `fib.cpp` in the working directory with a recursive
   `int fibonacci(int n)` (base case `n <= 1 → n`) and a `main` that prints
   `fibonacci(10)`.
2. Compile with `g++ -O0 fib.cpp -o fib`.
3. Disassemble and count instructions with
   `objdump -d fib | grep -E '^[[:space:]]+[0-9a-f]+:' | wc -l`.
4. Print exactly one final line: `INSTRUCTION_COUNT=<number>`.

**Reusable prompt** (paste verbatim — the explicit final-line format is what
makes the result mechanically checkable):

```
In the current working directory:
1. Create fib.cpp with a recursive `int fibonacci(int n)` (base case n<=1 returns n) and a main() that prints fibonacci(10).
2. Compile with: g++ -O0 fib.cpp -o fib
3. Count disassembled instructions: objdump -d fib | grep -E '^[[:space:]]+[0-9a-f]+:' | wc -l
4. As your last line of output, print exactly: INSTRUCTION_COUNT=<n>
```

**Per-case setup.** Each row uses its own cwd so runs cannot collide:

```sh
mkdir -p /tmp/cband-fib-tmux-cli      # 12.1
mkdir -p /tmp/cband-fib-xterm-cli     # 12.2
mkdir -p /tmp/cband-fib-tmux-daemon   # 12.3
mkdir -p /tmp/cband-fib-xterm-daemon  # 12.4
```

**Pass criteria for every row.**

- `fib` exists and is executable in the test cwd.
- `./fib` exits 0 (sanity check that the recursion compiled correctly).
- stdout contains a line matching `INSTRUCTION_COUNT=[0-9]+`.
- The session exits cleanly (no orphaned tmux window, no hung daemon owner).

| ID | Backend | Execution | Command | Notes |
|----|---------|-----------|---------|-------|
| 12.1 | tmux | local CLI | `claudraband --cwd /tmp/cband-fib-tmux-cli --backend tmux --permission-mode auto --model haiku "<prompt>"` | Default path. Permission mode `auto` lets `bash` run unattended. |
| 12.2 | xterm | local CLI | `claudraband --cwd /tmp/cband-fib-xterm-cli --backend xterm -c '--model haiku --dangerously-skip-permissions' "<prompt>"` | Local xterm requires the dangerous flag (see test 7.1). |
| 12.3 | tmux | daemon | Start: `claudraband serve --port 17842 --backend tmux --model haiku --permission-mode auto`<br>Then: `claudraband --connect localhost:17842 --cwd /tmp/cband-fib-tmux-daemon --model haiku "<prompt>"` | Daemon owns the tmux session; CLI is just the client. |
| 12.4 | xterm | daemon | Start: `claudraband serve --port 17843 --backend xterm -c '--model haiku --dangerously-skip-permissions'`<br>Then: `claudraband --connect localhost:17843 --cwd /tmp/cband-fib-xterm-daemon "<prompt>"` | The dangerous flag is passed to the daemon; the client inherits its session. |

**Cross-row checks.**

- The four `INSTRUCTION_COUNT` values should all be in the same ballpark
  (low thousands — exact value depends on the host `g++` and libc, but the
  number for the same cwd run twice should be deterministic).
- Run `claudraband sessions` after each row; the row's session should
  appear with `alive=true` (or be cleanable with `sessions close --all`).
- After all four rows, `claudraband sessions close --all` plus `kill` on
  the two daemons should leave no `claudraband-working-session` tmux
  windows behind (`tmux ls`).

## 13. Docker image (already-onboarded account)

Tests for the `claudraband-tmux` Docker image. **These tests assume the
mounted account is already onboarded** — they do not exercise the
first-run `claude` mode, theme picker, or login flow. The mounted bundle
at `/tmp/claude-account-bundle` must contain a populated `.claude/`
directory and a valid `.claude.json` from a prior interactive login.

**Conventions.**

- Image tag: `claudraband-tmux` (build from this repo with
  `docker build -t claudraband-tmux .` if needed).
- Account mount: `-v /tmp/claude-account-bundle:/claude-account`.
- Always uses `--model haiku` for any prompt sent through the container.
- Use `docker run --rm -d --name cband-docker-test -p 7842:7842 -v /tmp/claude-account-bundle:/claude-account claudraband-tmux`
  as the canonical run command. Each row may extend it with extra mounts
  or `serve` arguments; close the container with `docker stop cband-docker-test`
  between rows.

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 13.1 | Image starts and the daemon listens | `docker run --rm -d --name cband-docker-test -p 7842:7842 -v /tmp/claude-account-bundle:/claude-account claudraband-tmux`<br>then `curl -fsS localhost:7842/sessions` | `{"sessions":[]}` returned within 5s of `docker run` |
| 13.2 | Pre-onboarded mount is picked up cleanly | After 13.1, `docker logs cband-docker-test` and `docker exec cband-docker-test ls -la /root/.claude /root/.claude.json` | Logs contain no Claude onboarding prompts; `/root/.claude` and `/root/.claude.json` are symlinks into `/claude-account/` |
| 13.3 | Host CLI prompt round-trip to container daemon | After 13.1: `claudraband --connect localhost:7842 --model haiku "say exactly: DOCKER_OK"` | stdout contains `DOCKER_OK`; exit 0 |
| 13.4 | Resume + list + close via container daemon | After 13.3, capture `<id>`, then:<br>`claudraband prompt --session <id> --model haiku "what was my last instruction?"`<br>`claudraband sessions`<br>`claudraband sessions close --all` | Resume reply references the prior turn; `sessions` lists `<id>` with `alive=true`; close reports the session as closed |
| 13.5 | Container survives the §12 Fibonacci task | Restart per 13.1 with an extra mount: add `-v /tmp/cband-fib-docker:/tmp/cband-fib-docker` and `mkdir -p /tmp/cband-fib-docker` first.<br>Then run the §12 prompt:<br>`claudraband --connect localhost:7842 --cwd /tmp/cband-fib-docker --model haiku "<§12 prompt>"` | Same pass criteria as §12: `fib` exists in `/tmp/cband-fib-docker`, exits 0, stdout has `INSTRUCTION_COUNT=[0-9]+`. Count is in the same ballpark as §12 rows. |
| 13.6 | Clean shutdown on `docker stop` | `docker stop cband-docker-test` (default 10s SIGTERM grace) | Container exits within the grace window; no leftover container in `docker ps -a` after `--rm`; no port still bound on host (`ss -lnt sport = :7842`). |

**Cross-section parity check.** The §12 task should produce a comparable
`INSTRUCTION_COUNT` whether it runs on a native tmux daemon (12.3) or a
dockerized tmux daemon (13.5). A large divergence usually means the
container is using a different `g++` / libc and is informational, not a
failure — but the result must still be a valid integer in both rows.

---

## Test Results

Last run: (not yet run against current CLI)
