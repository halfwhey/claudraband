import {
  parseClaudeArgs,
  type PermissionMode,
  type TerminalBackend,
} from "claudraband-core";

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
  command: "prompt" | "sessions" | "resume" | "acp";
  prompt: string;
  sessionId: string;
  cwd: string;
  debug: boolean;
  approveAll: boolean;
  interactive: boolean;
  acp: boolean;
  claudeArgs: string[];
  model: string;
  permissionMode: PermissionMode;
  terminalBackend: TerminalBackend;
  select: string;
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
    acp: false,
    claudeArgs: [],
    model: "sonnet",
    permissionMode: "default",
    terminalBackend: "auto",
    select: "",
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
    } else if ((arg === "--claude" || arg === "-c") && i + 1 < argv.length) {
      try {
        config.claudeArgs.push(...splitShellWords(argv[++i]));
      } catch (err) {
        io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        io.stderr(USAGE);
        io.exit(1);
      }
    } else if (arg === "--terminal-backend" && i + 1 < argv.length) {
      config.terminalBackend = argv[++i] as TerminalBackend;
    } else if (arg === "--debug") {
      config.debug = true;
    } else if (arg === "--approve-all") {
      config.approveAll = true;
    } else if (arg === "--interactive" || arg === "-i") {
      config.interactive = true;
    } else if (arg === "--select" && i + 1 < argv.length) {
      config.select = argv[++i];
    } else if (arg === "--acp") {
      config.acp = true;
    } else if (arg === "--claude" || arg === "-c") {
      io.stderr("error: --claude requires a quoted flag string.\n");
      io.stderr(USAGE);
      io.exit(1);
    } else if (arg.startsWith("-")) {
      io.stderr(`error: unknown option ${arg}\n`);
      io.stderr(USAGE);
      io.exit(1);
    } else {
      positional.push(arg);
    }
    i++;
  }

  const parsedClaudeArgs = parseClaudeArgs(config.claudeArgs);
  config.claudeArgs = parsedClaudeArgs.passthroughArgs;
  config.model = parsedClaudeArgs.model ?? "sonnet";
  config.permissionMode = (parsedClaudeArgs.permissionMode as PermissionMode | undefined) ?? "default";

  if (config.acp) {
    if (positional.length > 0) {
      io.stderr("error: --acp does not accept positional arguments.\n");
      io.stderr(USAGE);
      io.exit(1);
    }
    config.command = "acp";
  } else if (positional[0] === "sessions") {
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
       claudraband --acp [options]
       claudraband sessions [--cwd <dir>]
       claudraband resume <sessionId> [options] [prompt...]

Options:
  -h, --help                     Show this help
  -i, --interactive              Start interactive REPL mode
  --acp                          Run as an ACP server over stdio
  --cwd <dir>                    Working directory (default: cwd)
  -c, --claude <flags>           Claude CLI flags, e.g. '--model sonnet --effort high'
  --terminal-backend <backend>   auto | tmux | xterm (default: auto)
  --debug                        Show debug logging
  --approve-all                  Auto-approve the first permission option
  --select <n>                   Auto-select option <n> for questions/permissions

Examples:
  claudraband "what changed in this repo?"
  claudraband -i
  claudraband --acp --claude "--model opus"
  claudraband sessions
  claudraband resume abc-123 "continue the refactor"
  claudraband --claude "--model sonnet --effort high --bypass-all-permissions" "write the tests"
  claudraband --terminal-backend xterm "run without tmux"
  claudraband resume abc-123 --select 1
  claudraband resume abc-123 --select 3 "my typed response"
`;

export function splitShellWords(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(`unterminated quote in --claude value`);
  }
  if (current) {
    out.push(current);
  }

  return out;
}
