import type { PermissionMode, TerminalBackend } from "claudraband";

interface ParseIo {
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number): never;
}

const defaultIo: ParseIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
};

export interface CliConfig {
  command: "prompt" | "sessions" | "resume";
  prompt: string;
  sessionId: string;
  cwd: string;
  debug: boolean;
  approveAll: boolean;
  interactive: boolean;
  model: string;
  permissionMode: PermissionMode;
  terminalBackend: TerminalBackend;
}

export function parseArgs(argv: string[], io: ParseIo = defaultIo): CliConfig {
  const config: CliConfig = {
    command: "prompt",
    prompt: "",
    sessionId: "",
    cwd: process.cwd(),
    debug: false,
    approveAll: false,
    interactive: false,
    model: "sonnet",
    permissionMode: "default",
    terminalBackend: "auto",
  };

  const positional: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      io.stdout(USAGE);
      io.exit(0);
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      config.cwd = argv[++i];
    } else if (arg === "--model" && i + 1 < argv.length) {
      config.model = argv[++i];
    } else if (arg === "--permission-mode" && i + 1 < argv.length) {
      config.permissionMode = argv[++i] as PermissionMode;
    } else if (arg === "--terminal-backend" && i + 1 < argv.length) {
      config.terminalBackend = argv[++i] as TerminalBackend;
    } else if (arg === "--debug") {
      config.debug = true;
    } else if (arg === "--approve-all") {
      config.approveAll = true;
    } else if (arg === "--interactive" || arg === "-i") {
      config.interactive = true;
    } else if (arg.startsWith("-")) {
      io.stderr(`error: unknown option ${arg}\n`);
      io.stderr(USAGE);
      io.exit(1);
    } else {
      positional.push(arg);
    }
    i++;
  }

  if (positional[0] === "sessions") {
    config.command = "sessions";
  } else if (positional[0] === "resume") {
    if (!positional[1]) {
      io.stderr("error: resume requires a session ID.\n");
      io.exit(1);
    }
    config.command = "resume";
    config.sessionId = positional[1];
    config.prompt = positional.slice(2).join(" ");
  } else {
    config.command = "prompt";
    config.prompt = positional.join(" ");
  }

  if (!config.prompt && !config.interactive && config.command === "prompt") {
    io.stderr("error: no prompt provided. Use --interactive / -i for REPL mode.\n");
    io.stderr(USAGE);
    io.exit(1);
  }

  return config;
}

export const USAGE = `Usage: claudraband [options] <prompt...>
       claudraband -i
       claudraband sessions [--cwd <dir>]
       claudraband resume <sessionId> [options] [prompt...]

Options:
  -h, --help                     Show this help
  -i, --interactive              Start interactive REPL mode
  --cwd <dir>                    Working directory (default: cwd)
  --model <model>                Claude model (default: sonnet)
  --permission-mode <mode>       Claude permission mode (default: default)
  --terminal-backend <backend>   auto | tmux | xterm (default: auto)
  --debug                        Show debug logging
  --approve-all                  Auto-approve the first permission option

Examples:
  claudraband "what changed in this repo?"
  claudraband -i
  claudraband sessions
  claudraband resume abc-123 "continue the refactor"
  claudraband --model opus --permission-mode acceptEdits "write the tests"
  claudraband --terminal-backend xterm "run without tmux"
`;
