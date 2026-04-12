import {
  parseClaudeArgs,
  type PermissionMode,
  type TerminalBackend,
} from "claudraband-core";
import { renderHelp, type HelpTopic } from "./help";

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

export type CliCommand =
  | "prompt"
  | "continue"
  | "attach"
  | "sessions"
  | "session-close"
  | "status"
  | "last"
  | "acp"
  | "serve";

export interface CliConfig {
  command: CliCommand;
  prompt: string;
  sessionId: string;
  answer: string;
  allSessions: boolean;
  cwd: string;
  hasExplicitCwd: boolean;
  debug: boolean;
  claudeArgs: string[];
  hasExplicitClaudeArgs: boolean;
  hasExplicitModel: boolean;
  hasExplicitPermissionMode: boolean;
  hasExplicitTerminalBackend: boolean;
  model: string;
  permissionMode: PermissionMode;
  terminalBackend: TerminalBackend;
  connect: string;
  host: string;
  port: number;
  warnings: string[];
}

export function parseArgs(argv: string[], io: ParseIo = defaultIo): CliConfig {
  const config: CliConfig = {
    command: "prompt",
    prompt: "",
    sessionId: "",
    answer: "",
    allSessions: false,
    cwd: process.cwd(),
    hasExplicitCwd: false,
    debug: false,
    claudeArgs: [],
    hasExplicitClaudeArgs: false,
    hasExplicitModel: false,
    hasExplicitPermissionMode: false,
    hasExplicitTerminalBackend: false,
    model: "sonnet",
    permissionMode: "default",
    terminalBackend: "auto",
    connect: "",
    host: "127.0.0.1",
    port: 7842,
    warnings: [],
  };

  const positional: string[] = [];
  let helpRequested = false;
  let selectAlias = "";
  let explicitModel: string | undefined;
  let explicitPermissionMode: PermissionMode | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      helpRequested = true;
      continue;
    }

    if (arg === "--cwd" && i + 1 < argv.length) {
      config.cwd = argv[++i];
      config.hasExplicitCwd = true;
      continue;
    }

    if ((arg === "--claude" || arg === "-c") && i + 1 < argv.length) {
      try {
        config.claudeArgs.push(...splitShellWords(argv[++i]));
      } catch (err) {
        io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        io.stderr(renderHelp("top"));
        io.exit(1);
      }
      continue;
    }

    if (arg === "--claude" || arg === "-c") {
      io.stderr("error: --claude requires a quoted flag string.\n");
      io.stderr(renderHelp("top"));
      io.exit(1);
    }

    if (arg === "--backend" && i + 1 < argv.length) {
      config.terminalBackend = argv[++i] as TerminalBackend;
      config.hasExplicitTerminalBackend = true;
      continue;
    }

    if (arg === "--model" && i + 1 < argv.length) {
      explicitModel = argv[++i];
      config.hasExplicitModel = true;
      continue;
    }

    if (arg === "--permission-mode" && i + 1 < argv.length) {
      explicitPermissionMode = argv[++i] as PermissionMode;
      config.hasExplicitPermissionMode = true;
      continue;
    }

    if (arg === "--debug") {
      config.debug = true;
      continue;
    }

    if (arg === "--select" && i + 1 < argv.length) {
      selectAlias = argv[++i];
      continue;
    }

    if (arg === "--all") {
      config.allSessions = true;
      continue;
    }

    if (arg === "--connect" && i + 1 < argv.length) {
      config.connect = argv[++i];
      continue;
    }

    if (arg === "--port" && i + 1 < argv.length) {
      config.port = parseInt(argv[++i], 10);
      continue;
    }

    if (arg === "--host" && i + 1 < argv.length) {
      config.host = argv[++i];
      continue;
    }

    if (arg.startsWith("-")) {
      io.stderr(`error: unknown option ${arg}\n`);
      io.stderr(renderHelp("top"));
      io.exit(1);
    }

    positional.push(arg);
  }

  const parsedClaudeArgs = parseClaudeArgs(config.claudeArgs);
  config.claudeArgs = parsedClaudeArgs.passthroughArgs;
  config.hasExplicitClaudeArgs = parsedClaudeArgs.passthroughArgs.length > 0;
  config.model = explicitModel ?? parsedClaudeArgs.model ?? "sonnet";
  config.permissionMode =
    explicitPermissionMode
    ?? (parsedClaudeArgs.permissionMode as PermissionMode | undefined)
    ?? "default";
  config.hasExplicitModel ||= parsedClaudeArgs.model !== undefined;
  config.hasExplicitPermissionMode ||= parsedClaudeArgs.permissionMode !== undefined;

  const helpTopic = resolveHelpTopic(positional);
  resolveCommand(config, positional, {
    selectAlias,
  });

  if (helpRequested) {
    io.stdout(renderHelp(helpTopic));
    io.exit(0);
  }

  if (selectAlias && config.command !== "continue") {
    io.stderr("error: --select only works with 'cband continue <session-id> ...'.\n");
    io.stderr(renderHelp("continue"));
    io.exit(1);
  }

  if (positional[0] === "answer") {
    io.stderr(
      "error: 'claudraband answer' has been removed. Use 'cband continue <session-id> --select <choice> [text]'.\n",
    );
    io.stderr(renderHelp("continue"));
    io.exit(1);
  }

  validateConfig(config, io);

  return config;
}

function resolveHelpTopic(positional: string[]): HelpTopic {
  if (positional[0] === "continue") return "continue";
  if (positional[0] === "attach") return "attach";
  if (positional[0] === "sessions" && positional[1] === "close") return "session-close";
  if (positional[0] === "sessions") return "sessions";
  if (positional[0] === "serve") return "serve";
  if (positional[0] === "status") return "status";
  if (positional[0] === "last") return "last";
  if (positional[0] === "acp") return "acp";
  return "top";
}

function resolveCommand(
  config: CliConfig,
  positional: string[],
  aliases: {
    selectAlias: string;
  },
): void {
  switch (positional[0]) {
    case "continue":
      config.command = "continue";
      config.sessionId = positional[1] ?? "";
      config.answer = aliases.selectAlias;
      config.prompt = positional.slice(2).join(" ");
      return;
    case "attach":
      config.command = "attach";
      config.sessionId = positional[1] ?? "";
      return;
    case "sessions":
      config.command = positional[1] === "close" ? "session-close" : "sessions";
      if (config.command === "session-close") {
        config.sessionId = positional[2] ?? "";
      }
      return;
    case "status":
      config.command = "status";
      config.sessionId = positional[1] ?? "";
      return;
    case "last":
      config.command = "last";
      config.sessionId = positional[1] ?? "";
      return;
    case "serve":
      config.command = "serve";
      return;
    case "acp":
      config.command = "acp";
      return;
    default:
      break;
  }

  config.command = "prompt";
  config.prompt = positional.join(" ");
}

function validateConfig(config: CliConfig, io: ParseIo): void {
  if (
    config.connect
    && (
      config.command === "continue"
      || config.command === "attach"
      || config.command === "sessions"
      || config.command === "session-close"
      || config.command === "status"
      || config.command === "last"
    )
  ) {
    io.stderr(
      "error: --connect is only for starting new daemon sessions. Existing tracked sessions route automatically.\n",
    );
    io.exit(1);
  }

  if (config.command === "attach") {
    if (!config.sessionId) {
      io.stderr("error: attach requires <session-id>.\n");
      io.stderr(renderHelp("attach"));
      io.exit(1);
    }
  }

  if (config.command === "status") {
    if (!config.sessionId) {
      io.stderr("error: status requires <session-id>.\n");
      io.stderr(renderHelp("status"));
      io.exit(1);
    }
  }

  if (config.command === "last") {
    if (!config.sessionId) {
      io.stderr("error: last requires <session-id>.\n");
      io.stderr(renderHelp("last"));
      io.exit(1);
    }
  }

  if (config.command === "continue") {
    if (!config.sessionId) {
      io.stderr("error: continue requires <session-id>.\n");
      io.stderr(renderHelp("continue"));
      io.exit(1);
    }
    if (!config.answer && !config.prompt) {
      io.stderr("error: continue requires either <prompt...> or --select <choice>.\n");
      io.stderr(renderHelp("continue"));
      io.exit(1);
    }
  }

  if (config.command === "session-close") {
    const bulkScopeCount = (config.allSessions ? 1 : 0) + (config.hasExplicitCwd ? 1 : 0);
    if (config.sessionId && bulkScopeCount > 0) {
      io.stderr("error: sessions close accepts either <session-id>, --cwd <dir>, or --all.\n");
      io.exit(1);
    }
    if (!config.sessionId && bulkScopeCount === 0) {
      io.stderr("error: sessions close requires <session-id>, --cwd <dir>, or --all.\n");
      io.stderr(renderHelp("session-close"));
      io.exit(1);
    }
    if (bulkScopeCount > 1) {
      io.stderr("error: sessions close accepts only one bulk scope: --cwd <dir> or --all.\n");
      io.exit(1);
    }
  }

  if (config.command === "sessions" && config.allSessions) {
    io.stderr("error: sessions does not accept --all. Use 'sessions close --all'.\n");
    io.exit(1);
  }

  if (config.command === "prompt" && !config.prompt) {
    io.stderr("error: no prompt provided.\n");
    io.stderr(renderHelp("top"));
    io.exit(1);
  }

  if (config.command !== "continue" && config.answer) {
    io.stderr("error: --select only works with 'cband continue <session-id> ...'.\n");
    io.stderr(renderHelp("continue"));
    io.exit(1);
  }

}

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
    throw new Error("unterminated quote in --claude value");
  }
  if (current) {
    out.push(current);
  }

  return out;
}
