# Test Cases

Comprehensive end-to-end test cases for claudraband.

**Convention:** All tests pass `--model haiku` or `-c '--model haiku'` to save costs.

**CLI binary:** `node packages/claudraband-cli/dist/bin.js`

---

## 1. Build, Typecheck, Unit Tests

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 1.1 | Build succeeds | `make build` | Exit 0, dist/ files produced |
| 1.2 | Typecheck passes | `make typecheck` | Exit 0 |
| 1.3 | Unit tests pass | `make test` | All tests pass (known flaky: tmux kill timing) |

## 2. CLI Argument Parsing & Validation

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 2.1 | Top-level help | `claudraband --help` | Prints usage with all commands, exit 0 |
| 2.2 | No prompt error | `claudraband` | Error: "no prompt provided" |
| 2.3 | Unknown flag | `claudraband --bogus` | Error: "unknown option --bogus" |
| 2.4 | Unterminated quote in `--claude` | `claudraband -c "'open` | Error: unterminated quote |
| 2.5 | `--claude` without value | `claudraband -c` | Error: "--claude requires a quoted flag string" |
| 2.6 | `sessions --all` rejected | `claudraband sessions --all` | Error: "sessions does not accept --all" |
| 2.7 | `sessions close` without scope | `claudraband sessions close` | Error: "requires a session ID, --cwd, or --all" |
| 2.8 | `sessions close` mixed bulk scopes | `claudraband sessions close --all --cwd /tmp` | Error: "accepts only one bulk scope" |
| 2.9 | `sessions close` with ID and --all | `claudraband sessions close abc --all` | Error: "accepts either session-id, --cwd, or --all" |
| 2.10a | `continue` missing session ID | `claudraband continue` | Error: "continue requires \<session-id\>." |
| 2.10b | `continue` missing prompt/select | `claudraband continue abc-123` | Error: "continue requires either \<prompt...\> or --select \<choice\>." |
| 2.11 | `attach` missing session ID | `claudraband attach` | Error: "attach requires \<session-id\>." |
| 2.12 | `answer` removed | `claudraband answer` | Error: "'claudraband answer' has been removed. Use 'cband continue \<session-id\> --select \<choice\> [text]'." |
| 2.13 | `status` missing session ID | `claudraband status` | Error: "status requires \<session-id\>." |
| 2.14 | `last` missing session ID | `claudraband last` | Error: "last requires \<session-id\>." |
| 2.15 | `--connect` rejected for tracked cmds | `claudraband continue abc --connect localhost:7842 hi` | Error: "--connect is only for starting new daemon sessions" |

## 3. Subcommand Help

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 3.1 | Sessions help | `claudraband sessions --help` | Prints sessions usage, exit 0 |
| 3.2 | Sessions close help | `claudraband sessions close --help` | Prints session-close usage, exit 0 |
| 3.3 | Continue help | `claudraband continue --help` | Prints continue usage, exit 0 |
| 3.4 | Attach help | `claudraband attach --help` | Prints attach usage, exit 0 |
| 3.5 | Answer (removed) with --help | `claudraband answer --help` | Prints top-level usage (answer has no help topic), exit 0 |
| 3.6 | Status help | `claudraband status --help` | Prints status usage, exit 0 |
| 3.7 | Last help | `claudraband last --help` | Prints last usage, exit 0 |
| 3.8 | Serve help | `claudraband serve --help` | Prints serve usage, exit 0 |
| 3.9 | ACP help | `claudraband acp --help` | Prints acp usage, exit 0 |

## 4. Removed Flag Rejection

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 4.1 | `--acp` rejected | `claudraband --acp` | Error: "unknown option --acp" |
| 4.2 | `-s` rejected | `claudraband -s abc-123 "keep going"` | Error: "unknown option -s" |
| 4.3 | `-i` rejected | `claudraband -i` | Error: "unknown option -i" |

## 5. Top-level Flags

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 5.1 | `--model` passthrough | `claudraband --model haiku "say ok"` | Uses haiku model |
| 5.2 | `--permission-mode` passthrough | `claudraband --model haiku --permission-mode acceptEdits "say ok"` | Uses acceptEdits mode |
| 5.3 | `--backend` explicit | `claudraband --backend tmux --model haiku "say ok"` | Uses tmux backend |
| 5.4 | `--claude` flag extraction | `claudraband -c '--model haiku --effort low' "say ok"` | Model extracted to haiku, --effort passed through |
| 5.5 | `--debug` shows session ID | `claudraband --debug --model haiku "say ok"` | stderr contains "session:" |
| 5.6 | `--cwd` custom working directory | `claudraband --cwd /tmp --model haiku "what directory are you in?"` | Response references /tmp |

## 6. Local tmux Session Lifecycle

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 6.1 | New session with prompt | `claudraband --model haiku "say hello world and nothing else"` | Prints hello world, exits cleanly |
| 6.2 | Session appears in list | `claudraband sessions` | Shows the session from 6.1 |
| 6.3 | Continue session with new prompt | `claudraband continue <id> --model haiku "say goodbye"` | Prints goodbye, uses existing session |
| 6.4 | Attach to live session | `echo "say hi" \| claudraband attach <id>` | Responds to prompt, exits on EOF |
| 6.5 | Close session by ID | `claudraband sessions close <id>` | Confirms closed |
| 6.6 | Close all sessions | `claudraband sessions close --all` | Closes all live sessions |
| 6.7 | Close by cwd | `claudraband sessions close --cwd /home/ludvi/Repos/allagent` | Closes sessions for that cwd |
| 6.8 | Session list after close | `claudraband sessions` | No live sessions |
| 6.9 | Close non-existent session | `claudraband sessions close nonexistent-uuid` | Error: not running/not found |
| 6.10 | Close by cwd with no matches | `claudraband sessions close --cwd /nonexistent` | "no live sessions found" |

## 7. Persistent Sessions (Detach / Reattach)

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 7.1 | Session persists after prompt | After 6.1, session tmux window still exists | `claudraband sessions` shows status=live |
| 7.2 | Continue recalls context | `claudraband continue <id> --model haiku "what was my last message?"` | Responds with context from session |
| 7.3 | Multiple sequential prompts | Send 3 prompts to same session via `continue` | Each gets a response, session stays alive |

## 8. Select Flow (Pending Questions)

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 8.1 | Trigger AskUserQuestion | `claudraband --model haiku "use the ask user question tool to ask me: red or blue?"` | Should defer and exit with session alive |
| 8.2 | Answer pending question | `claudraband continue <id> --select 1` | Sends selection, gets Claude's response |
| 8.3 | Answer with no pending question | `claudraband continue <id> --select 1` (after answered) | Error: "no pending question or permission prompt" |
| 8.4 | Answer on dead session | `claudraband continue <closed-id> --select 1` | Error: "not live" |
| 8.5 | Answer on non-existent session | `claudraband continue nonexistent --select 1` | Error message |

## 9. Status & Last Commands

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 9.1 | Status of existing session | `claudraband status <id>` | Prints session/source/alive/backend/cwd/pid/timestamps/title |
| 9.2 | Status of non-existent session | `claudraband status nonexistent-uuid` | Error: "session nonexistent-uuid not found" |
| 9.3 | Status of live session | Start a session, then `claudraband status <id>` | `alive    true` in output |
| 9.4 | Status of dead session | After closing, `claudraband status <id>` | `alive    false` in output |
| 9.5 | Status with --cwd | `claudraband status <id> --cwd /home/ludvi/Repos/allagent` | Shows session for that cwd |
| 9.6 | Last of session with history | `claudraband last <id>` | Prints the last assistant response text |
| 9.7 | Last of non-existent session | `claudraband last nonexistent-uuid` | Error: "session nonexistent-uuid not found" |
| 9.8 | Last of session with no messages | `claudraband last <id-with-no-response>` | Error: "no assistant message found" |
| 9.9 | Last with --cwd | `claudraband last <id> --cwd /home/ludvi/Repos/allagent` | Prints last message for that cwd |

## 10. Daemon Server Mode

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 10.1 | Start daemon | `claudraband serve --port 17842` | "daemon listening on port 17842" |
| 10.2 | New session via daemon | `claudraband --connect localhost:17842 --model haiku "say hello from daemon"` | Gets response via daemon |
| 10.3 | List daemon sessions | `claudraband sessions` | Shows session from 10.2 |
| 10.4 | Continue daemon session | `claudraband continue <id> --model haiku "still there?"` | Auto-routes through daemon, responds with context |
| 10.5 | Close daemon session | `claudraband sessions close <id>` | Auto-routes through daemon, confirms closed |
| 10.6 | Close all daemon sessions | `claudraband sessions close --all` | Closes all (daemon + local) |
| 10.7 | Daemon sessions after close | `claudraband sessions` | No sessions |
| 10.8 | Stop daemon | Send SIGINT to daemon process | Shuts down cleanly |

## 11. xterm Backend (Local, No Daemon)

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 11.1 | xterm without dangerous perms fails | `claudraband --backend xterm --model haiku "hello"` | Error: "local xterm backend requires dangerous permission settings" |
| 11.2 | xterm with dangerous perms | `claudraband --backend xterm -c '--model haiku --dangerously-skip-permissions' "say hi"` | Works or errors about missing dep |
| 11.3 | Auto backend without tmux | (mock test) If tmux not available, auto resolves to xterm and guard triggers | Error: requires dangerous perms |

## 12. Library API (Programmatic Usage)

| ID | Test | Script | Expected |
|----|------|--------|----------|
| 12.1 | createClaudraband + startSession + prompt | See script below | Gets response text |
| 12.2 | Event streaming | Subscribe to events, verify AssistantText received | Events stream correctly |
| 12.3 | Session detach + list | Start session, detach, list sessions | Session appears in list |
| 12.4 | Multi-session | Start two sessions concurrently | Both produce output |
| 12.5 | Permission callback | Set default mode, trigger tool use | onPermissionRequest fires |

Library test script (12.1):
```typescript
import { createClaudraband, EventKind } from "claudraband";
const rt = createClaudraband({ model: "haiku", permissionMode: "acceptEdits" });
const s = await rt.startSession({
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

## 13. Examples

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 13.1 | code-review.ts | `bun examples/code-review.ts` | Produces a code review |
| 13.2 | multi-session.ts | `bun examples/multi-session.ts` | Both sessions produce output |
| 13.3 | session-journal.ts | `bun examples/session-journal.ts` (after other tests) | Replays a session |

## 14. Edge Cases

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 14.1 | Empty prompt string | `claudraband ""` | Error or handles gracefully |
| 14.2 | Very long prompt | `claudraband --model haiku "<1000 char prompt>"` | Handles without crash |
| 14.3 | Special chars in prompt | `claudraband --model haiku "what is 2+2? say only the number"` | Responds correctly |
| 14.4 | Concurrent sessions (local) | Run two prompts in parallel | Both complete independently |
| 14.5 | Ambiguous session ID (multi-cwd) | `claudraband status <id>` where ID exists in multiple cwds | Error: "matched multiple transcript locations. Re-run with --cwd" |

## 15. ACP Mode

| ID | Test | Command | Expected |
|----|------|---------|----------|
| 15.1 | ACP starts without error | `claudraband acp --model haiku` (send initialize) | Responds to ACP protocol |

## 16. Daemon HTTP API

Automated tests in `packages/claudraband-cli/src/server-http.test.ts`. Run with `bun test packages/claudraband-cli/src/server-http.test.ts`.

These tests start the daemon on a random port with mock sessions (no real Claude processes) and exercise each HTTP endpoint.

| ID | Test | Method / Path | Expected |
|----|------|---------------|----------|
| 16.1 | Unknown route | `GET /bogus` | 404 + `{ error: "not found" }` |
| 16.2 | Create session | `POST /sessions` | 200 + `{ sessionId, backend }` |
| 16.3 | List sessions (empty) | `GET /sessions` | 200 + `{ sessions: [] }` |
| 16.4 | List sessions (after create) | `GET /sessions` | 200 + session in array with alive/hasPendingPermission |
| 16.5 | Action on non-existent session | `POST /sessions/bad-id/prompt` | 404 + error message |
| 16.6 | Prompt session | `POST /sessions/:id/prompt` | 200 + `{ stopReason: "end_turn" }` |
| 16.7 | Send raw text | `POST /sessions/:id/send` | 200 + `{ ok: true }` |
| 16.8 | Send and await turn | `POST /sessions/:id/send-and-await-turn` | 200 + `{ stopReason: "end_turn" }` |
| 16.9 | Await turn | `POST /sessions/:id/await-turn` | 200 + `{ stopReason: "end_turn" }` |
| 16.10 | Interrupt | `POST /sessions/:id/interrupt` | 200 + `{ ok: true }` |
| 16.11 | Detach (no-op) | `POST /sessions/:id/detach` | 200 + `{ ok: true }` |
| 16.12 | Pending question (none) | `GET /sessions/:id/pending-question` | 200 + `{ pending: false, source: "none" }` |
| 16.13 | Permission with none pending | `POST /sessions/:id/permission` | 409 + `{ error: "no pending permission request" }` |
| 16.14 | Delete session | `DELETE /sessions/:id` | 200 + `{ ok: true }`, session removed from list |
| 16.15 | Delete non-existent session | `DELETE /sessions/bad-id` | 404 |
| 16.16 | SSE events stream | `GET /sessions/:id/events` | `text/event-stream` content-type, ready event sent |
| 16.17 | Resume live session | `POST /sessions/:id/resume` | 200 + `{ reattached: true }` |
| 16.18 | Resume dead session (requireLive) | `POST /sessions/dead-id/resume` | 409 + error |
| 16.19 | Resume non-existent session (restart) | `POST /sessions/old-id/resume` | 200 + `{ reattached: false }` |
| 16.20 | Status of session | `GET /sessions/:id/status` | 200 + session summary (sessionId, cwd, alive, backend, etc.) |
| 16.21 | Status of non-existent session | `GET /sessions/missing/status` | 404 + `{ error: "session missing not found" }` |
| 16.22 | Last assistant text | `GET /sessions/:id/last` | 200 + `{ sessionId, cwd, text }` |
| 16.23 | Last of non-existent session | `GET /sessions/missing/last` | 404 + `{ error: "session missing not found" }` |
| 16.24 | Last with no assistant message | `GET /sessions/:id/last` | 404 + `{ error: "no assistant message found for session ..." }` |

---

## Test Results

Last run: (not yet run against current CLI)
