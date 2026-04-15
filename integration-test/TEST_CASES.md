# Test Cases

End-to-end test cases for claudraband. Each case below requires a real Claude
process or live session state — pure parsing, help, and validation tests are
covered in the unit suite (`packages/claudraband-cli/src/*.test.ts`,
`packages/claudraband-core/src/*.test.ts`) and are not duplicated here.

**Conventions**

- All tests pass `--model haiku` or `-c '--model haiku'` to save costs.
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
| 4.7 | Free-text "Other" answer | `claudraband prompt --session <id> --select 0 "use the blue theme"` | Selection then text delivered, response returned |

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

---

## Test Results

Last run: (not yet run against current CLI)
