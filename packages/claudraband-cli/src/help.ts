export type HelpTopic =
  | "top"
  | "continue"
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
  cband continue <session-id> [options] <prompt...>
  cband continue <session-id> --select <choice> [text]
  cband attach <session-id>
  cband sessions [--cwd <dir>]
  cband sessions close <session-id>
  cband sessions close --cwd <dir>
  cband sessions close --all
  cband status <session-id>
  cband last <session-id>
  cband serve [options]
  cband acp [options]

Commands:
  <prompt...>         Start a new session and send a prompt
  continue            Resume a tracked session and send another prompt
  attach              Reconnect interactively to a live session
  sessions            List live tracked sessions
  sessions close      Close one or more live tracked sessions
  status              Show status and metadata for a single session
  last                Print the last assistant message from a session
  serve               Run the persistent daemon for headless sessions
  acp                 Run claudraband as an ACP server over stdio

Common options:
  -h, --help                     Show help for the current command
  --cwd <dir>                    Working directory for new sessions
  --model <model>                haiku | sonnet | opus
  --permission-mode <mode>       default | plan | auto | acceptEdits | dontAsk | bypassPermissions
  --backend <backend>            auto | tmux | xterm (default: auto)
  -c, --claude <flags>           Advanced Claude CLI passthrough flags
  --connect <host:port>          Start a new session on a running daemon
  --debug                        Show debug logging

Examples:
  cband "review the staged diff"
  cband continue abc-123 "keep going"
  cband continue abc-123 --select 2
  cband continue abc-123 --select 3 "xyz"
  cband attach abc-123
  cband sessions --cwd /my/project
  cband sessions close --all
  cband status abc-123
  cband last abc-123
  cband serve --port 7842
  cband --connect localhost:7842 "start a headless refactor"

Notes:
  continue and attach route through the live session registry first.
  sessions lists only live tracked sessions.`,

  continue: `Usage:
  cband continue <session-id> [options] <prompt...>
  cband continue <session-id> --select <choice> [text]

Resume a tracked session. You can either send another prompt or answer a
pending AskUserQuestion with --select. If the recorded owner is a live daemon,
claudraband reconnects there automatically. If the daemon is gone, claudraband
resumes the Claude session locally from its recorded cwd.

If the live session is already waiting on a choice, bare prompts are rejected.
You must pick an option with --select. Use '--select 0 "text"' to cancel the
pending prompt first and then send follow-up text.

Options:
  -h, --help                     Show this help
  --select <choice>              Answer a pending question in a live session
  --model <model>                Override the model for this turn
  --permission-mode <mode>       Override Claude permission mode
  --backend <backend>            Local backend when a local resume is needed
  --cwd <dir>                    Override cwd if the session is not tracked
  -c, --claude <flags>           Advanced Claude CLI passthrough flags
  --debug                        Show debug logging

Examples:
  cband continue abc-123 "keep going"
  cband continue abc-123 --select 2
  cband continue abc-123 --select 3 "xyz"
  cband continue abc-123 --select 0 "new direction"
  cband continue abc-123 --model opus "finish the migration"`,

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
  cband status <session-id>

Show the status and metadata for a single session.

Options:
  -h, --help    Show this help
  --cwd <dir>   Disambiguate if the session id matches multiple cwds

Examples:
  cband status abc-123`,

  last: `Usage:
  cband last <session-id>

Print the last assistant message from a session's transcript.

Options:
  -h, --help    Show this help
  --cwd <dir>   Disambiguate if the session id matches multiple cwds

Examples:
  cband last abc-123`,

  serve: `Usage:
  cband serve [options]

Run the persistent daemon for headless sessions. New sessions started with
--connect are created there. Existing tracked sessions do not require --connect
for continue, attach, or sessions management.

Options:
  -h, --help                     Show this help
  --host <addr>                  Host to listen on (default: 127.0.0.1)
  --port <n>                     Port to listen on (default: 7842)
  --model <model>                Default model for daemon-created sessions
  --permission-mode <mode>       Default permission mode
  --backend <backend>            Backend for daemon-created sessions
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
