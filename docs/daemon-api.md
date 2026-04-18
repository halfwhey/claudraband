# Daemon HTTP API

`claudraband serve` starts an HTTP server for persistent sessions. Most endpoints accept and return JSON. Live session events are streamed over Server-Sent Events (SSE).

Start a daemon locally:

```sh
claudraband serve --host 127.0.0.1 --port 7842
```

The daemon defaults to `tmux`. `--backend xterm` is still supported, but it is currently experimental.

This document covers the raw HTTP API exposed by `cband serve`.

## Aligned verbs

The HTTP surface mirrors the CLI verbs. Every aligned verb has a matching CLI command and a matching library method.

| Concept | HTTP | CLI | Library |
|---|---|---|---|
| Open or resume | `POST /sessions` | implicit via `--session` | `runtime.openSession({ sessionId? })` |
| Prompt (or answer pending) | `POST /sessions/:id/prompt` | `prompt` | `session.prompt(text)` / `session.answerPending(choice, text?)` |
| Send (or answer pending, fire-and-forget) | `POST /sessions/:id/send` | `send` | `session.send(text)` |
| Watch (stream) | `GET /sessions/:id/watch` (SSE) | `watch` | `session.events()` |
| Interrupt | `POST /sessions/:id/interrupt` | `interrupt` | `session.interrupt()` |
| Last | `GET /sessions/:id/last` | `last` | `runtime.getLastMessage(id, cwd)` |
| Status | `GET /sessions/:id/status` | `status` | `runtime.getStatus(id, cwd?)` |

Use `/prompt` when you want a single request/response call that returns the completed assistant text as JSON. Use `/send` when you want fire-and-forget delivery and pair it with `/watch` for live streaming. Both endpoints accept `select` in the request body for answering pending questions or permission prompts.

## Sessions

### `POST /sessions`

Open a daemon-owned Claude Code session. Without `sessionId` this creates a new session. With `sessionId` it auto-resumes the saved session, or reattaches if the daemon already owns a live process for that id.

Request body (all fields optional):

```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "claudeArgs": ["--effort", "high"],
  "model": "sonnet",
  "permissionMode": "default",
  "autoAcceptStartupPrompts": false
}
```

Response:

```json
{
  "sessionId": "abc-123",
  "backend": "tmux",
  "resumed": true,
  "pendingInput": "none"
}
```

`resumed` is `true` when the body included a `sessionId` (whether the daemon reattached an existing live process or cold-resumed from disk), `false` for new sessions.
`pendingInput` is `"permission"` when the newly created session is blocked on a startup-native prompt and must be continued with `select`.

If `sessionId` is provided but no saved transcript exists for that id, the daemon returns `404`. If `sessionId` is not a valid UUID, the daemon returns `400`.

### `GET /sessions`

List the sessions currently tracked by this daemon process.

Response:

```json
{
  "sessions": [
    {
      "sessionId": "abc-123",
      "alive": true,
      "hasPendingPermission": false
    }
  ]
}
```

### `DELETE /sessions/:id`

Stop a daemon-owned session and remove it from the daemon.

Response:

```json
{ "ok": true }
```

### `GET /sessions/:id/status`

Inspect one session and return its merged status. Works for sessions the runtime can still inspect, not just sessions currently attached to this daemon process.

Optional query parameters:

- `cwd`: disambiguate the session when needed

Response:

```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "title": "Audit auth flow",
  "createdAt": "2026-04-12T10:00:00.000Z",
  "updatedAt": "2026-04-12T10:05:00.000Z",
  "backend": "tmux",
  "source": "live",
  "alive": true,
  "reattachable": true,
  "owner": {
    "kind": "daemon",
    "serverUrl": "http://127.0.0.1:7842",
    "serverPid": 12345,
    "serverInstanceId": "daemon-1"
  },
  "turnInProgress": false,
  "pendingInput": "none"
}
```

`pendingInput` is one of `"none"`, `"question"` (the transcript has an unresolved `AskUserQuestion`), or `"permission"` (a native permission prompt is currently visible for the session, including startup prompts).

### `GET /sessions/:id/last`

Return the last complete assistant turn from a session transcript.

Optional query parameters:

- `cwd`: disambiguate the session when needed

Response:

```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "text": "The riskiest part of this change is the migration ordering...",
  "pendingInput": "none"
}
```

`text` is `null` when the session exists but has no completed assistant turn yet.

## Prompting

### `POST /sessions/:id/prompt`

Send input and wait for Claude's turn to complete. Mirrors `cband prompt`.

Request body:

```json
{ "text": "explain the auth middleware" }
```

To answer a pending `AskUserQuestion` or permission prompt, pass `select` instead of (or alongside) `text`:

```json
{ "select": "2" }
```

`select` uses Claude's raw option numbers. For the bypass-permissions startup warning, acceptance is `2`, not `1`.

When the selected option expects free text, include `text` as well:

```json
{ "select": "3", "text": "use the blue theme" }
```

The body must contain `text`, `select`, or both. Empty bodies return `400`.

Response:

```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "stopReason": "end_turn",
  "text": "The auth middleware rejects unauthenticated requests before the route handler runs.",
  "pendingInput": "none",
  "eventSeq": 42
}
```

`text` is the assistant text produced by this completed turn. `pendingInput` signals whether Claude ended by asking for more input. `eventSeq` is the last SSE sequence number emitted for that turn; it is only useful for clients that are also consuming `/watch`.

If the session is already blocked on a pending question or permission prompt and the request body omits `select`, the daemon returns `409` and includes `pendingInput` in the JSON error body.

### `POST /sessions/:id/send`

Write input and return as soon as it is delivered. Mirrors `cband send`. Does not wait for a turn to finish. Pair this with `/watch` when you want live streamed output.

Request body shape is identical to `/prompt`:

```json
{ "text": "2" }
```

Or with `select` (and optional follow-up `text`) to answer a pending question or permission prompt without waiting:

```json
{ "select": "2" }
```

```json
{ "select": "3", "text": "use the blue theme" }
```

The body must contain `text`, `select`, or both. Empty bodies return `400`.

Response:

```json
{ "ok": true }
```

### `POST /sessions/:id/interrupt`

Send Ctrl-C to the Claude process. No request body.

Response:

```json
{ "ok": true }
```

## Events

### `GET /sessions/:id/watch`

Open an SSE stream for live session events. This is the daemon side of the `watch` verb and is the streaming companion to `/send`.

The daemon sends a ready event immediately after the stream opens:

```text
data: {"type":"ready"}
```

Normal session events are emitted as JSON objects on `data:` lines. Session events include a monotonically increasing `seq` value:

```text
data: {"seq":1,"kind":"assistant_text","time":"2025-01-15T10:00:00.000Z","text":"Hello"}
data: {"seq":2,"kind":"tool_call","time":"...","toolName":"Read","toolID":"tool_1","toolInput":"{...}"}
data: {"seq":3,"kind":"tool_result","time":"...","toolID":"tool_1","text":"file contents..."}
data: {"seq":4,"kind":"turn_end","time":"...","text":""}
```

Supported event kinds use snake_case:

- `user_message`
- `assistant_text`
- `assistant_thinking`
- `tool_call`
- `tool_result`
- `turn_end`
- `system`
- `error`

`user_message` may appear when the underlying Claude transcript emits one. The daemon does not synthesize a `user_message` event just because `/prompt` was called.

When Claude requests permission, the daemon pushes a permission event over the same stream:

```text
data: {"seq":5,"type":"permission_request","title":"Run bash command","options":[{"optionId":"1","name":"Allow"}]}
```

If a permission request is already pending when the SSE connection opens, it is sent immediately after the ready event.

## Errors

All errors return a JSON body:

```json
{ "error": "session abc-123 not found" }
```

| Status | Meaning |
|---|---|
| `400` | Bad request, such as a non-UUID `sessionId` |
| `404` | Session not found, or unknown route |
| `409` | Conflict, such as missing `select` while input is pending, or `select` with no pending input |
| `500` | Internal server error |
