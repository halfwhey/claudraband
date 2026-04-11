import {
  parseClaudeArgs,
  resolveTerminalBackend,
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
  command: "prompt" | "sessions" | "session-close" | "acp" | "serve";
  prompt: string;
  sessionId: string;
  allSessions: boolean;
  cwd: string;
  hasExplicitCwd: boolean;
  debug: boolean;
  interactive: boolean;
  acp: boolean;
  claudeArgs: string[];
  hasExplicitClaudeArgs: boolean;
  hasExplicitModel: boolean;
  hasExplicitPermissionMode: boolean;
  hasExplicitTerminalBackend: boolean;
  model: string;
  permissionMode: PermissionMode;
  terminalBackend: TerminalBackend;
  select: string;
  server: string;
  port: number;
}

export function parseArgs(argv: string[], io: ParseIo = defaultIo): CliConfig {
  const config: CliConfig = {
    command: "prompt",
    prompt: "",
    sessionId: "",
    allSessions: false,
    cwd: process.cwd(),
    hasExplicitCwd: false,
    debug: false,
    interactive: false,
    acp: false,
    claudeArgs: [],
    hasExplicitClaudeArgs: false,
    hasExplicitModel: false,
    hasExplicitPermissionMode: false,
    hasExplicitTerminalBackend: false,
    model: "sonnet",
    permissionMode: "default",
    terminalBackend: "auto",
    select: "",
    server: "",
    port: 7842,
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
      config.hasExplicitCwd = true;
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
      config.hasExplicitTerminalBackend = true;
    } else if (arg === "--debug") {
      config.debug = true;
    } else if (arg === "--interactive" || arg === "-i") {
      config.interactive = true;
    } else if ((arg === "--session" || arg === "-s") && i + 1 < argv.length) {
      config.sessionId = argv[++i];
    } else if (arg === "--select" && i + 1 < argv.length) {
      config.select = argv[++i];
    } else if (arg === "--all") {
      config.allSessions = true;
    } else if (arg === "--server" && i + 1 < argv.length) {
      config.server = argv[++i];
    } else if (arg === "--port" && i + 1 < argv.length) {
      config.port = parseInt(argv[++i], 10);
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
  config.hasExplicitClaudeArgs = parsedClaudeArgs.passthroughArgs.length > 0;
  config.hasExplicitModel = parsedClaudeArgs.model !== undefined;
  config.hasExplicitPermissionMode = parsedClaudeArgs.permissionMode !== undefined;
  config.model = parsedClaudeArgs.model ?? "sonnet";
  config.permissionMode = (parsedClaudeArgs.permissionMode as PermissionMode | undefined) ?? "default";

  // Route positional commands.
  if (config.acp) {
    if (positional.length > 0) {
      io.stderr("error: --acp does not accept positional arguments.\n");
      io.stderr(USAGE);
      io.exit(1);
    }
    config.command = "acp";
  } else if (positional[0] === "sessions" && positional[1] === "close") {
    config.command = "session-close";
    config.sessionId = positional[2] ?? "";
  } else if (positional[0] === "sessions") {
    config.command = "sessions";
  } else if (positional[0] === "serve") {
    config.command = "serve";
  } else {
    config.command = "prompt";
    config.prompt = positional.join(" ");
  }

  // Validation.

  if (config.select && !config.sessionId) {
    io.stderr("error: --select requires --session <id>.\n");
    io.exit(1);
  }

  if (config.command === "session-close") {
    const bulkScopeCount =
      (config.allSessions ? 1 : 0) +
      (config.hasExplicitCwd ? 1 : 0);
    if (config.sessionId && bulkScopeCount > 0) {
      io.stderr("error: 'sessions close' accepts either <id>, --all, or --cwd <dir>.\n");
      io.exit(1);
    }
    if (!config.sessionId && bulkScopeCount === 0) {
      io.stderr("error: sessions close requires a session ID, --all, or --cwd <dir>.\n");
      io.exit(1);
    }
    if (bulkScopeCount > 1) {
      io.stderr("error: 'sessions close' accepts only one bulk scope: --all or --cwd <dir>.\n");
      io.exit(1);
    }
  }

  if (config.command === "sessions" && config.allSessions) {
    io.stderr("error: 'sessions' does not accept --all. Use 'sessions close --all' to bulk close.\n");
    io.exit(1);
  }

  if (config.sessionId && !config.prompt && !config.select && !config.interactive
      && config.command === "prompt") {
    io.stderr("error: --session requires a prompt, --select, or --interactive.\n");
    io.exit(1);
  }

  if (!config.prompt && !config.interactive && !config.select
      && config.command === "prompt" && !config.sessionId) {
    io.stderr("error: no prompt provided. Use --interactive / -i for REPL mode.\n");
    io.stderr(USAGE);
    io.exit(1);
  }

  // xterm guard: local xterm without daemon requires dangerous permission mode.
  if (config.command === "prompt" && !config.server) {
    let resolved: "tmux" | "xterm";
    try {
      resolved = resolveTerminalBackend(config.terminalBackend);
    } catch {
      // resolveTerminalBackend throws if tmux backend is requested but
      // tmux isn't installed. Treat that as xterm for the guard.
      resolved = "xterm";
    }
    if (resolved === "xterm" && !isDangerousPermissionMode(config)) {
      io.stderr(
        "error: local xterm backend requires dangerous permission settings.\n" +
        "  Either:\n" +
        "    --server <host:port>   (use a claudraband daemon)\n" +
        "    --terminal-backend tmux\n" +
        '    -c "--dangerously-skip-permissions"\n',
      );
      io.exit(1);
    }
  }

  return config;
}

function isDangerousPermissionMode(config: CliConfig): boolean {
  if (config.permissionMode === "bypassPermissions") return true;
  if (config.permissionMode === "dontAsk") return true;
  if (config.claudeArgs.includes("--dangerously-skip-permissions")) return true;
  return false;
}

export const USAGE = `Usage: claudraband [options] <prompt...>
       claudraband -s <id> <prompt...>
       claudraband -s <id> --select <n>
       claudraband -s <id> -i
       claudraband sessions close <sessionId>
       claudraband sessions close --all
       claudraband sessions close --cwd <dir>
       claudraband sessions [--cwd <dir>]
       claudraband serve [--port <n>]
       claudraband --acp [options]

Options:
  -h, --help                     Show this help
  -s, --session <id>             Target an existing session
  -i, --interactive              Start interactive REPL mode
  --select <n>                   Auto-select option <n> for a pending question (requires -s)
  --all                          Close every live tracked session for 'sessions close'
  --acp                          Run as an ACP server over stdio
  --cwd <dir>                    Working directory (default: cwd)
  -c, --claude <flags>           Claude CLI flags, e.g. '--model sonnet --effort high'
  --terminal-backend <backend>   auto | tmux | xterm (default: auto)
  --server <host:port>           Connect to a claudraband daemon instead of running locally
  --port <n>                     Port for the serve command (default: 7842)
  --debug                        Show debug logging

Examples:
  claudraband "what changed in this repo?"
  claudraband -i
  claudraband -s abc-123 "continue the refactor"
  claudraband -s abc-123 --select 2
  claudraband -s abc-123 -i
  claudraband sessions
  claudraband sessions close abc-123
  claudraband sessions close --all
  claudraband sessions close --cwd /my/project
  claudraband --acp --claude "--model opus"
  claudraband serve --port 7842
  claudraband --server localhost:7842 "hello"
  claudraband --terminal-backend xterm -c "--dangerously-skip-permissions" "run without tmux"
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
