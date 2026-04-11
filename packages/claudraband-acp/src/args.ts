import type { TerminalBackend } from "claudraband";

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

export interface AcpConfig {
  model: string;
  debug: boolean;
  terminalBackend: TerminalBackend;
}

export const USAGE = `Usage: claudraband-acp [options]

Options:
  -h, --help                     Show this help
  --model <model>                Claude model (default: sonnet)
  --terminal-backend <backend>   auto | tmux | xterm (default: auto)
  --debug                        Show debug logging

Examples:
  claudraband-acp
  claudraband-acp --model opus
  claudraband-acp --terminal-backend xterm
`;

export function parseArgs(
  args: string[],
  io: ParseIo = defaultIo,
): AcpConfig {
  let model = "sonnet";
  let debug = false;
  let terminalBackend: TerminalBackend = "auto";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      io.stdout(USAGE);
      io.exit(0);
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === "--terminal-backend" && i + 1 < args.length) {
      terminalBackend = args[++i] as TerminalBackend;
    } else if (arg === "--debug") {
      debug = true;
    } else if (arg.startsWith("-")) {
      io.stderr(`error: unknown option ${arg}\n`);
      io.stderr(USAGE);
      io.exit(1);
    }
  }

  return { model, debug, terminalBackend };
}
