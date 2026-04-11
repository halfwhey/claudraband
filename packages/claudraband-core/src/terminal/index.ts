import { spawnSync } from "node:child_process";
import { Session } from "../tmuxctl";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";

export type TerminalBackend = "auto" | "tmux" | "xterm";
export type ResolvedTerminalBackend = Exclude<TerminalBackend, "auto">;
export type XtermTransportKind = "node-pty" | "bun-terminal";

export interface TerminalStartOptions {
  cwd: string;
  cols: number;
  rows: number;
  signal: AbortSignal;
}

export interface TerminalHost {
  readonly backend: ResolvedTerminalBackend;
  start(command: string[], options: TerminalStartOptions): Promise<void>;
  stop(): Promise<void>;
  send(input: string): Promise<void>;
  interrupt(): Promise<void>;
  capture(): Promise<string>;
  alive(): boolean;
}

export interface CreateTerminalHostOptions {
  backend: TerminalBackend;
  tmuxSessionName: string;
}

type TmuxDetector = () => boolean;
type BunRuntimeDetector = () => boolean;

interface PtyTransport {
  start(
    command: string[],
    options: TerminalStartOptions,
    onOutput: (data: string) => void,
    onExit: () => void,
  ): Promise<void>;
  stop(): Promise<void>;
  write(data: string): void;
  alive(): boolean;
}

function getModuleExports<T>(mod: T): T {
  if (
    typeof mod === "object" &&
    mod !== null &&
    "default" in mod &&
    (mod as { default?: T }).default
  ) {
    return (mod as { default: T }).default;
  }
  return mod;
}

export function hasTmuxBinary(): boolean {
  const result = spawnSync("tmux", ["-V"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function hasBunTerminalRuntime(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.Terminal === "function";
}

export function resolveXtermTransportKind(
  detectBunRuntime: BunRuntimeDetector = hasBunTerminalRuntime,
): XtermTransportKind {
  return detectBunRuntime() ? "bun-terminal" : "node-pty";
}

export function resolveTerminalBackend(
  backend: TerminalBackend,
  detectTmux: TmuxDetector = hasTmuxBinary,
): ResolvedTerminalBackend {
  if (backend === "auto") {
    return detectTmux() ? "tmux" : "xterm";
  }
  if (backend === "tmux" && !detectTmux()) {
    throw new Error(
      "terminal backend 'tmux' was requested, but tmux is not available on PATH",
    );
  }
  return backend;
}

export function createTerminalHost(
  options: CreateTerminalHostOptions,
): TerminalHost {
  const backend = resolveTerminalBackend(options.backend);
  if (backend === "tmux") {
    return new TmuxTerminalHost(options.tmuxSessionName);
  }
  return new XtermTerminalHost();
}

class TmuxTerminalHost implements TerminalHost {
  readonly backend = "tmux" as const;

  private session: Session | null = null;

  constructor(private readonly sessionName: string) {}

  async start(command: string[], options: TerminalStartOptions): Promise<void> {
    this.session = await Session.newSession(
      this.sessionName,
      options.cols,
      options.rows,
      options.cwd,
      command,
    );
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.session.kill().catch(() => {});
    this.session = null;
  }

  async send(input: string): Promise<void> {
    if (!this.session) throw new Error("tmux terminal is not started");
    await this.session.sendLine(input);
  }

  async interrupt(): Promise<void> {
    if (!this.session) throw new Error("tmux terminal is not started");
    await this.session.interrupt();
  }

  async capture(): Promise<string> {
    if (!this.session) throw new Error("tmux terminal is not started");
    return this.session.capturePane();
  }

  alive(): boolean {
    return this.session !== null && this.session.isAlive;
  }
}

class XtermTerminalHost implements TerminalHost {
  readonly backend = "xterm" as const;

  private transport: PtyTransport | null = null;
  private terminal: HeadlessTerminal | null = null;
  private serializeAddon: SerializeAddon | null = null;
  private outputDrain: Promise<void> = Promise.resolve();
  private exited = false;

  async start(command: string[], options: TerminalStartOptions): Promise<void> {
    if (command.length === 0) {
      throw new Error("xterm terminal requires a command");
    }

    const [headlessModule, serializeModule] = await Promise.all([
      import("@xterm/headless"),
      import("@xterm/addon-serialize"),
    ]);
    const { Terminal } = getModuleExports(headlessModule);
    const { SerializeAddon } = getModuleExports(serializeModule);

    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: options.cols,
      rows: options.rows,
      scrollback: 5000,
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
    this.exited = false;
    this.transport = await createPtyTransport();

    // xterm is a terminal emulator, not just a buffer. Claude probes the
    // terminal and expects emulator responses to flow back into the PTY.
    this.terminal.onData((data) => {
      this.transport?.write(data);
    });
    this.terminal.onBinary((data) => {
      this.transport?.write(data);
    });

    await this.transport.start(
      command,
      options,
      (data) => {
        this.outputDrain = this.outputDrain
          .then(
            () =>
              new Promise<void>((resolve) => {
                this.terminal?.write(data, () => resolve());
              }),
          )
          .catch(() => {});
      },
      () => {
        this.exited = true;
      },
    );

    options.signal.addEventListener(
      "abort",
      () => {
        void this.stop();
      },
      { once: true },
    );
  }

  async stop(): Promise<void> {
    await this.transport?.stop().catch(() => {});
    this.transport = null;
    this.serializeAddon = null;
    this.exited = true;
    await this.outputDrain.catch(() => {});
  }

  async send(input: string): Promise<void> {
    if (!this.transport) throw new Error("xterm terminal is not started");
    if (input) {
      this.transport.write(input);
    }
    this.transport.write("\r");
  }

  async interrupt(): Promise<void> {
    if (!this.transport) throw new Error("xterm terminal is not started");
    this.transport.write("\u0003");
  }

  async capture(): Promise<string> {
    if (!this.serializeAddon) throw new Error("xterm terminal is not started");
    await this.outputDrain;
    return this.serializeAddon.serialize();
  }

  alive(): boolean {
    return this.transport !== null && this.transport.alive() && !this.exited;
  }
}

async function createPtyTransport(): Promise<PtyTransport> {
  if (resolveXtermTransportKind() === "bun-terminal") {
    return new BunTerminalTransport();
  }
  return new NodePtyTransport();
}

class NodePtyTransport implements PtyTransport {
  private pty: {
    write(data: string): void;
    kill(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: () => void): void;
  } | null = null;
  private aliveFlag = false;

  async start(
    command: string[],
    options: TerminalStartOptions,
    onOutput: (data: string) => void,
    onExit: () => void,
  ): Promise<void> {
    if (command.length === 0) {
      throw new Error("xterm terminal requires a command");
    }
    const ptyModule = await import("node-pty");
    const pty = getModuleExports(ptyModule);
    const [file, ...args] = command;
    this.pty = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });
    this.aliveFlag = true;
    this.pty.onData((data: string) => {
      onOutput(data);
    });
    this.pty.onExit(() => {
      this.aliveFlag = false;
      onExit();
    });
  }

  async stop(): Promise<void> {
    if (!this.pty) return;
    try {
      this.pty.kill();
    } catch {
      // Best effort shutdown.
    }
    this.pty = null;
    this.aliveFlag = false;
  }

  write(data: string): void {
    if (!this.pty) throw new Error("node-pty transport is not started");
    this.pty.write(data);
  }

  alive(): boolean {
    return this.pty !== null && this.aliveFlag;
  }
}

class BunTerminalTransport implements PtyTransport {
  private terminal: Bun.Terminal | null = null;
  private process: { kill(signal?: number | string): void } | null = null;
  private decoder = new TextDecoder();
  private aliveFlag = false;

  async start(
    command: string[],
    options: TerminalStartOptions,
    onOutput: (data: string) => void,
    onExit: () => void,
  ): Promise<void> {
    if (command.length === 0) {
      throw new Error("xterm terminal requires a command");
    }
    if (!hasBunTerminalRuntime()) {
      throw new Error("bun terminal transport requires Bun runtime");
    }

    this.terminal = new Bun.Terminal({
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data: (_terminal, data) => {
        const text = this.decoder.decode(data, { stream: true });
        if (text) {
          onOutput(text);
        }
      },
      exit: () => {
        this.aliveFlag = false;
        const rest = this.decoder.decode();
        if (rest) {
          onOutput(rest);
        }
        onExit();
      },
    });

    this.process = Bun.spawn(command, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      terminal: this.terminal,
    }) as { kill(signal?: number | string): void };

    this.aliveFlag = true;
  }

  async stop(): Promise<void> {
    if (!this.terminal && !this.process) return;
    try {
      this.process?.kill();
    } catch {
      // Best effort shutdown.
    }
    try {
      this.terminal?.close();
    } catch {
      // Best effort shutdown.
    }
    this.process = null;
    this.terminal = null;
    this.aliveFlag = false;
  }

  write(data: string): void {
    if (!this.terminal) throw new Error("bun terminal transport is not started");
    this.terminal.write(data);
  }

  alive(): boolean {
    return this.terminal !== null && !this.terminal.closed && this.aliveFlag;
  }
}
