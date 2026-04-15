# claudraband library

`claudraband` is both a CLI and a TypeScript library. Install it once and you get programmatic control over real local Claude Code sessions.

For the command-line interface, see [docs/cli.md](cli.md).

```sh
npm install @halfwhey/claudraband
```

## Quick start

```typescript
import { createClaudraband } from "@halfwhey/claudraband";

const runtime = createClaudraband({ model: "sonnet" });
const session = await runtime.openSession({ cwd: "/my/project" });

const result = await session.prompt("explain the entry point");
console.log(result.stopReason); // "end_turn"

await session.detach(); // session stays alive in tmux
```

## Core API

### `createClaudraband(defaults?): Claudraband`

Creates a runtime with optional defaults applied to every session.

```typescript
const runtime = createClaudraband({
  model: "opus",
  permissionMode: "acceptEdits",
  terminalBackend: "tmux",
  logger: console,
});
```

By default, the runtime resolves bundled Claude Code `@anthropic-ai/claude-code@2.1.96`. For advanced override cases, pass `claudeExecutable` or set `CLAUDRABAND_CLAUDE_PATH`.

### `Claudraband`

| Method | Description |
|---|---|
| `openSession(options?)` | Start a new session, or auto-resume when `options.sessionId` is provided. Throws `SessionNotFoundError` if the id has no saved transcript. |
| `listSessions(cwd?)` | List live registry-backed sessions plus transcript-backed history |
| `inspectSession(sessionId, cwd?)` | Inspect one live or historical session (lower-level than `getStatus`) |
| `getStatus(sessionId, cwd?)` | Merged status: `SessionSummary` plus `turnInProgress` and `pendingInput` |
| `getLastMessage(sessionId, cwd)` | Text of the most recent complete assistant turn, or `null` |
| `closeSession(sessionId)` | Close a tracked live session through its recorded owner |
| `replaySession(sessionId, cwd)` | Parse a session's JSONL into events without starting Claude |

CLI and daemon parity:

- `cband status --session <id>` and `GET /sessions/:id/status` are built on `getStatus(...)`
- `cband last --session <id>` and `GET /sessions/:id/last` are built on `getLastMessage(...)`
- `cband prompt --session <id>` and `POST /sessions { sessionId }` are built on `openSession({ sessionId })`

### `ClaudrabandSession`

Returned by `openSession`.

| Method | Description |
|---|---|
| `prompt(text)` | Send a prompt and wait for the turn to complete |
| `send(text)` | Send raw input to the terminal without waiting |
| `answerPending(choice, text?)` | Answer a pending `AskUserQuestion`. Optional `text` is sent after the selection when the chosen option accepts free text. |
| `interrupt()` | Send Ctrl-C to cancel the in-progress turn |
| `stop()` | Kill the Claude Code process |
| `detach()` | Disconnect without killing (tmux window stays alive) |
| `events()` | Async iterable of session events |
| `capturePane()` | Snapshot of the terminal's visible content |
| `isProcessAlive()` | Whether the backing terminal process is running |
| `hasPendingInput()` | Check whether the live terminal still has a pending question |
| `setModel(model)` | Switch model mid-session |
| `setPermissionMode(mode)` | Switch permission mode (restarts Claude) |

**Properties:** `sessionId`, `cwd`, `backend`, `model`, `permissionMode`

### `SessionStatus`

Returned by `runtime.getStatus(...)` and emitted by `GET /sessions/:id/status`.

```typescript
interface SessionStatus extends SessionSummary {
  turnInProgress: boolean;
  pendingInput: "none" | "question" | "permission";
}
```

`pendingInput` is `"question"` when the transcript contains an unresolved `AskUserQuestion`, `"permission"` when a native permission prompt is visible in the live pane, and `"none"` otherwise.

### `SessionNotFoundError`

Thrown by `openSession({ sessionId })` when no saved transcript exists for `sessionId`.

```typescript
import { SessionNotFoundError } from "@halfwhey/claudraband";

try {
  await runtime.openSession({ sessionId: "missing" });
} catch (err) {
  if (err instanceof SessionNotFoundError) {
    console.log(`no saved session ${err.sessionId}`);
  }
}
```

## Streaming events

`session.events()` returns an `AsyncIterable<ClaudrabandEvent>`. Events keep flowing regardless of whether a prompt is active.

```typescript
import { createClaudraband, EventKind } from "@halfwhey/claudraband";

const runtime = createClaudraband();
const session = await runtime.openSession({ cwd: "." });

// Start consuming events in the background
const stream = (async () => {
  for await (const event of session.events()) {
    switch (event.kind) {
      case EventKind.AssistantText:
        process.stdout.write(event.text);
        break;
      case EventKind.ToolCall:
        console.log(`tool: ${event.toolName}`);
        break;
      case EventKind.ToolResult:
        console.log(`result: ${event.text.slice(0, 100)}`);
        break;
    }
  }
})();

await session.prompt("list all TODO comments");
await session.detach();
await stream;
```

### Event kinds

| Kind | Fields | Description |
|---|---|---|
| `UserMessage` | `text` | Echoed user prompt |
| `AssistantText` | `text` | Claude's response text |
| `AssistantThinking` | `text` | Extended thinking content |
| `ToolCall` | `toolName`, `toolID`, `toolInput` | Tool invocation |
| `ToolResult` | `toolID`, `text` | Tool output |
| `TurnEnd` | none | Explicit Claude turn completion |
| `System` | `text` | System messages, progress |
| `Error` | `text` | Errors |

## Permission handling

When Claude requests permission for a tool (or asks a question via `AskUserQuestion`), the `onPermissionRequest` callback fires.

```typescript
const session = await runtime.openSession({
  cwd: ".",
  onPermissionRequest: async (request) => {
    console.log(`Permission: ${request.title}`);
    for (const opt of request.options) {
      console.log(`  ${opt.optionId}. ${opt.name}`);
    }

    // Auto-approve everything
    return { outcome: "selected", optionId: request.options[0].optionId };
  },
});
```

### Decision types

```typescript
// Select a numbered option
{ outcome: "selected", optionId: "1" }

// Send free-text for a text-input option
{ outcome: "text", text: "use the blue theme" }

// Leave the question pending (session stays alive, answer later)
{ outcome: "deferred" }

// Cancel (sends Ctrl-C)
{ outcome: "cancelled" }
```

## Session lifecycle

```typescript
// Start fresh
const session = await runtime.openSession({ cwd: "/project" });

// Detach -- Claude keeps running in tmux
await session.detach();

// Later: auto-resume the same session by id
const resumed = await runtime.openSession({
  sessionId: session.sessionId,
  cwd: "/project",
});
await resumed.prompt("what were you working on?");
await resumed.detach();

// When you're done for good
const final = await runtime.openSession({
  sessionId: session.sessionId,
  cwd: "/project",
});
await final.stop(); // kills the process
```

With the tmux backend, sessions persist across CLI invocations. `detach()` disconnects the library without killing the tmux window. `stop()` kills it.

`~/.claudraband/` stores only live sessions. Historical sessions come from Claude transcript discovery. The live registry carries the session ID, cwd, backend, liveness, and owner-routing metadata needed for close and reconnect operations.

## Listing and replaying sessions

```typescript
// List all sessions for a directory
const sessions = await runtime.listSessions("/my/project");
for (const s of sessions) {
  console.log(`${s.sessionId}  ${s.backend}  ${s.updatedAt}  ${s.title}`);
}

// Replay a session's history without starting Claude
const events = await runtime.replaySession(sessionId, "/my/project");
for (const event of events) {
  if (event.kind === EventKind.AssistantText) {
    process.stdout.write(event.text);
  }
}

// Or just grab the last assistant turn's text
const text = await runtime.getLastMessage(sessionId, "/my/project");
```

## Options reference

### `OpenSessionOptions`

Passed to `runtime.openSession(...)`.

| Option | Type | Default | Description |
|---|---|---|---|
| `sessionId` | `string` | `undefined` | When set, auto-resume this saved session. Throws `SessionNotFoundError` if missing. |
| `cwd` | `string` | `process.cwd()` | Working directory for Claude |
| `model` | `string` | `"sonnet"` | Claude model |
| `claudeArgs` | `string[]` | `[]` | Extra flags passed to `claude` CLI |
| `claudeExecutable` | `string` | bundled `@anthropic-ai/claude-code@2.1.96` | Override the Claude executable path |
| `permissionMode` | `PermissionMode` | `"default"` | Permission mode |
| `terminalBackend` | `TerminalBackend` | `"auto"` | `"auto"`, `"tmux"`, or `"xterm"` |
| `paneWidth` | `number` | `120` | Terminal width |
| `paneHeight` | `number` | `40` | Terminal height |
| `logger` | `ClaudrabandLogger` | no-op | Logging interface |
| `onPermissionRequest` | callback | `undefined` | Permission handler |
| `sessionOwner` | owner record | inferred | Internal routing metadata for session ownership |

`ClaudrabandOptions` is the same shape minus `sessionId`, and is what `createClaudraband(defaults)` accepts.

### `PermissionMode`

`"default"` | `"plan"` | `"auto"` | `"acceptEdits"` | `"dontAsk"` | `"bypassPermissions"`

### `TerminalBackend`

- `"auto"` -- prefers tmux, falls back to xterm
- `"tmux"` -- persistent sessions in a shared tmux session
- `"xterm"` -- headless PTY (requires `node-pty` under Node, uses `Bun.Terminal` under Bun)

## Utility exports

| Export | Description |
|---|---|
| `extractLastAssistantTurn(events)` | Pure helper that finds the last complete assistant turn in an event list |
| `sessionPath(cwd, sessionId)` | Path to a session's JSONL file |
| `hasPendingQuestion(jsonlPath)` | Whether the JSONL has an unresolved AskUserQuestion |
| `hasLiveProcess(sessionId)` | Whether a tmux window exists for this session |
| `closeLiveProcess(sessionId)` | Kill a session's tmux window |
| `resolveTerminalBackend(backend)` | Resolve `"auto"` to `"tmux"` or `"xterm"` |
| `EventKind` | Enum of event types |
| `MODEL_OPTIONS` | Available model choices |
| `PERMISSION_MODES` | Available permission modes |
| `TERMINAL_BACKENDS` | Available backend choices |
