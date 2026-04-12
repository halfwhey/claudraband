# Daemon HTTP API

`claudraband serve` starts an HTTP server for persistent sessions. Most endpoints accept and return JSON. Live session events are streamed over Server-Sent Events (SSE).

Start a daemon locally:

```sh
claudraband serve --host 127.0.0.1 --port 7842
```

The daemon defaults to `tmux`. `--backend xterm` is still supported, but it is currently experimental.

This document covers the raw HTTP API exposed by `cband serve`.

## Sessions

### `POST /sessions`

Start a new daemon-owned Claude Code session.

Request body:

```json
{
  "cwd": "/path/to/project",
  "claudeArgs": ["--effort", "high"],
  "model": "sonnet",
  "permissionMode": "default"
}
```

All fields are optional. Omitted fields fall back to the daemon's launch defaults.

Response:

```json
{
  "sessionId": "abc-123",
  "backend": "tmux"
}
```

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

### `POST /sessions/:id/resume`

Resume a known session. If the session is still alive on the daemon, the existing process is reused. If it is dead, the daemon starts a new Claude process with `--resume`.

Request body:

```json
{
  "cwd": "/path/to/project",
  "claudeArgs": [],
  "model": "sonnet",
  "permissionMode": "default",
  "requireLive": false
}
```

Set `requireLive: true` to fail instead of restarting a dead session. This is what `continue --select` uses when it must target an already-live session.

Response:

```json
{
  "sessionId": "abc-123",
  "reattached": true,
  "backend": "tmux"
}
```

`reattached: true` means the existing process was reused. `false` means a new process was started via `--resume`.

### `DELETE /sessions/:id`

Stop a daemon-owned session and remove it from the daemon.

Response:

```json
{ "ok": true }
```

### `GET /sessions/:id/status`

Inspect one session and return its current summary. This works for sessions the runtime can still inspect, not just sessions currently attached to this daemon process.

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
  }
}
```

### `GET /sessions/:id/last`

Return the last assistant message from a session transcript.

Optional query parameters:

- `cwd`: disambiguate the session when needed

Response:

```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "text": "The riskiest part of this change is the migration ordering..."
}
```

If the session exists but has no assistant message yet, the daemon returns `404`.

## Prompting

### `POST /sessions/:id/prompt`

Send a normal prompt and wait for Claude's turn to complete.

Request body:

```json
{ "text": "explain the auth middleware" }
```

Response:

```json
{
  "stopReason": "end_turn",
  "eventSeq": 42
}
```

`eventSeq` is the last SSE sequence number emitted for this completed turn. The official daemon client uses it to wait until all matching events have been rendered before disconnecting.

### `POST /sessions/:id/send`

Write raw terminal input. This does not wait for a turn to finish.

Request body:

```json
{ "text": "2" }
```

Response:

```json
{ "ok": true }
```

### `POST /sessions/:id/send-and-await-turn`

Write raw terminal input and wait for the next turn to complete. This is used for flows like `continue --select`.

Request body:

```json
{ "text": "2" }
```

Response:

```json
{
  "stopReason": "end_turn",
  "eventSeq": 45
}
```

### `POST /sessions/:id/await-turn`

Wait for the current in-progress turn to finish. No request body.

Response:

```json
{
  "stopReason": "end_turn",
  "eventSeq": 45
}
```

### `POST /sessions/:id/interrupt`

Send Ctrl+C to the Claude process. No request body.

Response:

```json
{ "ok": true }
```

## Events

### `GET /sessions/:id/events`

Open an SSE stream for live session events.

The daemon sends a ready event immediately after the stream opens:

```text
data: {"type":"ready"}
```

Normal session events are emitted as JSON objects on `data:` lines. Session events include a monotonically increasing `seq` value:

```text
data: {"seq":1,"kind":"AssistantText","time":"2025-01-15T10:00:00.000Z","text":"Hello"}
data: {"seq":2,"kind":"ToolCall","time":"...","toolName":"Read","toolID":"tool_1","toolInput":"{...}"}
data: {"seq":3,"kind":"ToolResult","time":"...","toolID":"tool_1","text":"file contents..."}
data: {"seq":4,"kind":"TurnEnd","time":"...","text":""}
```

Supported event kinds:

- `UserMessage`
- `AssistantText`
- `AssistantThinking`
- `ToolCall`
- `ToolResult`
- `TurnEnd`
- `System`
- `Error`

When Claude requests permission, the daemon pushes a permission event over the same stream:

```text
data: {"seq":5,"type":"permission_request","title":"Run bash command","options":[{"optionId":"1","name":"Allow"}]}
```

If a permission request is already pending when the SSE connection opens, it is sent immediately after the ready event.

## Permissions and pending input

### `GET /sessions/:id/pending-question`

Check whether the live session is blocked on user input.

Response:

```json
{
  "pending": true,
  "source": "permission_request"
}
```

`source` is one of:

- `"none"`
- `"permission_request"`
- `"terminal"`

### `POST /sessions/:id/permission`

Resolve a pending permission request.

Select an option:

```json
{ "outcome": "selected", "optionId": "1" }
```

Send free text:

```json
{ "outcome": "text", "text": "use the blue theme" }
```

Cancel:

```json
{ "outcome": "cancelled" }
```

Response:

```json
{ "ok": true }
```

Returns `409` if no permission request is pending.

## Relationship to CLI and library

- CLI `status` maps closely to `GET /sessions/:id/status`.
- CLI `last` maps closely to `GET /sessions/:id/last`.
- The TypeScript library exposes the same lower-level pieces as `inspectSession(...)` and `replaySession(...)`.

## Errors

All errors return a JSON body:

```json
{ "error": "session abc-123 not found" }
```

| Status | Meaning |
|---|---|
| `404` | Session not found or unknown route |
| `409` | Conflict, such as `requireLive` failure or no pending permission |
| `500` | Internal server error |
