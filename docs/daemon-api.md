# Daemon HTTP API

`claudraband serve` starts an HTTP server that manages persistent headless sessions. All endpoints accept and return JSON unless noted otherwise.

**Default port:** 7842

```sh
claudraband serve --host 127.0.0.1 --port 7842
```

---

## Sessions

### Create session

```
POST /sessions
```

**Body:**

```json
{
  "cwd": "/path/to/project",
  "claudeArgs": ["--effort", "high"],
  "model": "sonnet",
  "permissionMode": "default"
}
```

All fields are optional. Omitted fields fall back to the daemon's launch defaults.

**Response:**

```json
{
  "sessionId": "abc-123",
  "backend": "xterm"
}
```

### List sessions

```
GET /sessions
```

**Response:**

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

### Resume session

```
POST /sessions/:id/resume
```

If the session is still alive on the daemon, reattaches to it. If the session is dead, starts a new Claude process with `--resume`.

**Body:**

```json
{
  "cwd": "/path/to/project",
  "claudeArgs": [],
  "model": "sonnet",
  "permissionMode": "default",
  "requireLive": false
}
```

Set `requireLive: true` to fail instead of restarting a dead session (used by `continue --select`).

**Response:**

```json
{
  "sessionId": "abc-123",
  "reattached": true,
  "backend": "xterm"
}
```

`reattached: true` means the existing process was reused. `false` means a new process was started via `--resume`.

### Delete session

```
DELETE /sessions/:id
```

Kills the Claude process and removes the session from the daemon.

**Response:**

```json
{ "ok": true }
```

---

## Prompting

### Send prompt

```
POST /sessions/:id/prompt
```

Sends a prompt and waits for Claude's turn to complete.

**Body:**

```json
{ "text": "explain the auth middleware" }
```

**Response:**

```json
{
  "stopReason": "end_turn"
}
```

### Send raw text

```
POST /sessions/:id/send
```

Writes raw text to the terminal. Does not wait for a response.

**Body:**

```json
{ "text": "2" }
```

**Response:**

```json
{ "ok": true }
```

### Send and await turn

```
POST /sessions/:id/send-and-await-turn
```

Sends raw text to the terminal and waits for the next turn to complete. Used by `continue --select` to type a selection and collect the response.

**Body:**

```json
{ "text": "2" }
```

**Response:**

```json
{
  "stopReason": "end_turn"
}
```

### Await turn

```
POST /sessions/:id/await-turn
```

Waits for the current in-progress turn to finish. No request body.

**Response:**

```json
{
  "stopReason": "end_turn"
}
```

### Interrupt

```
POST /sessions/:id/interrupt
```

Sends Ctrl+C to the Claude process. No request body.

**Response:**

```json
{ "ok": true }
```

---

## Events

### Event stream (SSE)

```
GET /sessions/:id/events
```

Returns a Server-Sent Events stream. Each event is a JSON object on a `data:` line.

**Ready event** (sent immediately on connect):

```
data: {"type":"ready"}
```

**Session events:**

```
data: {"kind":"AssistantText","time":"2025-01-15T10:00:00.000Z","text":"Hello"}
data: {"kind":"ToolCall","time":"...","toolName":"Read","toolID":"tool_1","toolInput":"{...}"}
data: {"kind":"ToolResult","time":"...","toolID":"tool_1","text":"file contents..."}
data: {"kind":"TurnEnd","time":"...","text":""}
```

Event kinds: `UserMessage`, `AssistantText`, `AssistantThinking`, `ToolCall`, `ToolResult`, `TurnEnd`, `System`, `Error`.

**Permission request** (pushed when Claude needs approval):

```
data: {"type":"permission_request","title":"Run bash command","options":[{"optionId":"1","name":"Allow"}]}
```

If a permission request is already pending when you connect, it is sent immediately after the ready event.

---

## Permissions

### Check pending input

```
GET /sessions/:id/pending-question
```

**Response:**

```json
{
  "pending": true,
  "source": "permission_request"
}
```

`source` is one of `"none"`, `"permission_request"`, or `"terminal"`.

### Resolve permission

```
POST /sessions/:id/permission
```

Resolves a pending permission request.

**Body (select an option):**

```json
{ "outcome": "selected", "optionId": "1" }
```

**Body (free-text response):**

```json
{ "outcome": "text", "text": "use the blue theme" }
```

**Body (cancel):**

```json
{ "outcome": "cancelled" }
```

**Response:**

```json
{ "ok": true }
```

Returns `409` if no permission request is pending.

---

## Detach

### Detach

```
POST /sessions/:id/detach
```

No-op on the server side (the session stays alive). Exists for client symmetry.

**Response:**

```json
{ "ok": true }
```

---

## Errors

All errors return a JSON body:

```json
{ "error": "session abc-123 not found" }
```

| Status | Meaning |
|---|---|
| 404 | Session not found, or unknown route |
| 409 | Conflict (e.g. no pending permission, or `requireLive` failed) |
| 500 | Internal error |
