export type HelpTopic =
  | "top"
  | "prompt"
  | "send"
  | "watch"
  | "interrupt"
  | "attach"
  | "sessions"
  | "session-close"
  | "status"
  | "last"
  | "serve"
  | "acp";

const HELP_TEXT: Record<HelpTopic, string> = {
  top: `Usage:
  cband [options] <prompt...>
  cband prompt [--session <id>] [--select <choice>] <prompt...>
  cband send [--session <id>] <text...>
  cband watch --session <id>
  cband interrupt --session <id>
  cband status --session <id>
  cband last --session <id>
  cband attach <session-id>
  cband sessions [--cwd <dir>]
  cband sessions close <session-id>
  cband sessions close --cwd <dir>
  cband sessions close --all
  cband serve [options]
  cband acp [options]

Commands:
  prompt              Send text and wait for the response (default)
  send                Send text without waiting
  watch               Stream events from a session (SSE / polling)
  interrupt           Cancel the current turn on a session
  status              Show status and metadata for a session
  last                Print the last assistant message from a session
  attach              Reconnect interactively to a live session
  sessions            List live tracked sessions
  sessions close      Close one or more live tracked sessions
  serve               Run the persistent daemon for headless sessions
  acp                 Run claudraband as an ACP server over stdio

Common options:
  -h, --help                     Show help for the current command
  --session <id>                 Resume (prompt/send) or target an existing session
  --cwd <dir>                    Working directory for new sessions
  --model <model>                haiku | sonnet | opus
  --permission-mode <mode>       default | plan | auto | acceptEdits | dontAsk | bypassPermissions
  --backend <backend>            auto | tmux | xterm (default: auto)
  --turn-detection <mode>        terminal | events (default: terminal)
  -c, --claude <flags>           Advanced Claude CLI passthrough flags
  --connect <host:port>          Route new sessions through a running daemon
  --json                         Emit JSON (status, last, watch)
  --debug                        Show debug logging

Examples:
  cband "review the staged diff"
  cband prompt --session abc-123 "keep going"
  cband prompt --session abc-123 --select 2
  cband send --session abc-123 "quick note"
  cband send --session abc-123 --select 2
  cband watch --session abc-123
  cband interrupt --session abc-123
  cband status --session abc-123
  cband last --session abc-123
  cband attach abc-123
  cband serve --port 7842
  cband --connect localhost:7842 "start a headless refactor"

Notes:
  Providing --session to prompt or send auto-resumes that saved session;
  missing session ids fail with "session not found".`,

  prompt: `Usage:
  cband prompt [--session <id>] [--select <choice>] <prompt...>
  cband [--session <id>] <prompt...>

Send a prompt and wait for the assistant's reply. Without --session a new
session is created. With --session the saved session is auto-resumed; if the
id has no saved transcript, the command errors.

--select answers a pending AskUserQuestion before the optional follow-up text.

Options:
  -h, --help                     Show this help
  --session <id>                 Resume the saved session with this id
  --select <choice>              Answer a pending question (1-based index; 0 = Other)
  --model <model>                Override the model for this turn
  --permission-mode <mode>       Override Claude permission mode
  --backend <backend>            Local backend when starting a new session
  --turn-detection <mode>        terminal | events
  --cwd <dir>                    Working directory for new sessions
  -c, --claude <flags>           Advanced Claude CLI passthrough flags
  --connect <host:port>          Create the session through a running daemon
  --json                         Emit JSON result
  --debug                        Show debug logging

Examples:
  cband prompt "review the staged diff"
  cband prompt --session abc-123 "keep going"
  cband prompt --session abc-123 --select 2
  cband prompt --session abc-123 --select 0 "new direction"`,

  send: `Usage:
  cband send [--session <id>] [--select <choice>] <text...>

Send text to the session without waiting for a response. Returns as soon as
the input is delivered. Use status, last, or watch to observe the response.

--select answers a pending AskUserQuestion (fire-and-forget variant of
'cband prompt --select'). Optional trailing text is sent after the selection.

Options:
  -h, --help                     Show this help
  --session <id>                 Resume the saved session with this id
  --select <choice>              Fire a pending-question answer (1-based; 0 = Other)
  --cwd <dir>                    Working directory for new sessions
  --debug                        Show debug logging

Examples:
  cband send --session abc-123 "quick note"
  cband send --session abc-123 --select 2
  cband send --session abc-123 --select 0 "new direction"
  cband send "begin a new background task"`,

  watch: `Usage:
  cband watch --session <id> [--pretty] [--no-follow]

Stream events from a session. When a daemon owns the session this connects to
the SSE stream; otherwise it polls the local event iterator. One event per line
as JSON by default.

Options:
  -h, --help                     Show this help
  --session <id>                 Target session (required)
  --pretty                       Render events as human-readable text
  --no-follow                    Exit after the next turn ends
  --debug                        Show debug logging

Examples:
  cband watch --session abc-123
  cband watch --session abc-123 --pretty
  cband watch --session abc-123 --no-follow`,

  interrupt: `Usage:
  cband interrupt --session <id>

Cancel the in-progress turn on a live session (the Ctrl-C equivalent).

Options:
  -h, --help                     Show this help
  --session <id>                 Target session (required)
  --debug                        Show debug logging

Examples:
  cband interrupt --session abc-123`,

  attach: `Usage:
  cband attach <session-id>

Open a simple REPL against a live session. This does not reattach the original
terminal UI; it just lets you keep talking to the session interactively. It is
especially useful for headless xterm sessions running in the daemon.

The session must already be live in tmux or in the daemon. attach does not
restart dead sessions.

Options:
  -h, --help                     Show this help
  --debug                        Show debug logging

Examples:
  cband attach abc-123`,

  sessions: `Usage:
  cband sessions [--cwd <dir>]

List live tracked sessions.

Options:
  -h, --help                     Show this help
  --cwd <dir>                    Filter sessions by working directory
  --debug                        Show debug logging

Examples:
  cband sessions
  cband sessions --cwd /my/project`,

  "session-close": `Usage:
  cband sessions close <session-id>
  cband sessions close --cwd <dir>
  cband sessions close --all

Close one or more live tracked sessions. claudraband reads the registry first,
then routes each close request through the recorded owner.

Options:
  -h, --help                     Show this help
  --cwd <dir>                    Close all live sessions for one working directory
  --all                          Close every live tracked session
  --debug                        Show debug logging

Examples:
  cband sessions close abc-123
  cband sessions close --cwd /my/project
  cband sessions close --all`,

  status: `Usage:
  cband status --session <id>
  cband status <session-id>

Show status and metadata for a session, including whether a turn is in
progress and whether input is pending.

Options:
  -h, --help                     Show this help
  --session <id>                 Target session
  --cwd <dir>                    Disambiguate if the id matches multiple cwds
  --json                         Emit JSON payload

Examples:
  cband status --session abc-123
  cband status abc-123 --json`,

  last: `Usage:
  cband last --session <id>
  cband last <session-id>

Print the last complete assistant turn's text from the transcript.

Options:
  -h, --help                     Show this help
  --session <id>                 Target session
  --cwd <dir>                    Disambiguate if the id matches multiple cwds
  --json                         Emit JSON payload

Examples:
  cband last --session abc-123
  cband last abc-123 --json`,

  serve: `Usage:
  cband serve [options]

Run the persistent daemon for headless sessions. New sessions started with
--connect are created there. Existing tracked sessions do not require --connect
for attach or sessions management.

Options:
  -h, --help                     Show this help
  --host <addr>                  Host to listen on (default: 127.0.0.1)
  --port <n>                     Port to listen on (default: 7842)
  --model <model>                Default model for daemon-created sessions
  --permission-mode <mode>       Default permission mode
  --backend <backend>            Backend for daemon-created sessions
  --turn-detection <mode>        terminal | events
  --cwd <dir>                    Default cwd for daemon-created sessions
  -c, --claude <flags>           Default Claude CLI passthrough flags
  --debug                        Show debug logging

Examples:
  cband serve
  cband serve --host 0.0.0.0 --port 7842
  cband serve --port 7842
  cband serve --backend tmux`,

  acp: `Usage:
  cband acp [options]

Run claudraband as an ACP server over stdio.

Options:
  -h, --help                     Show this help
  --model <model>                Default model
  --permission-mode <mode>       Default permission mode
  --backend <backend>            Backend for ACP-created sessions
  --turn-detection <mode>        terminal | events
  --cwd <dir>                    Default cwd
  -c, --claude <flags>           Advanced Claude CLI passthrough flags
  --debug                        Show debug logging

Examples:
  cband acp
  cband acp --model opus
  cband acp -c "--model haiku --effort high"`,
};

export function renderHelp(topic: HelpTopic = "top"): string {
  return `${HELP_TEXT[topic]}\n`;
}
