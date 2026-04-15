import { spawnSync } from "node:child_process";
import { Session, listWindows } from "../tmuxctl";
import { awaitPaneIdle } from "./activity";
import type { PaneActivityOptions, ActivityResult } from "./activity";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { IPty } from "node-pty";

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
  /** Disconnect without killing the process. For tmux the window stays alive. */
  detach(): Promise<void>;
  /**
   * Reattach to an existing terminal by window name (tmux) or id.
   * Returns true if an existing process was found, false otherwise.
   */
  reattach(windowName: string): Promise<boolean>;
  send(input: string): Promise<void>;
  interrupt(): Promise<void>;
  capture(): Promise<string>;
  currentPath(): Promise<string | undefined>;
  /** Poll capture() until the pane content stabilizes. */
  awaitIdle(options?: PaneActivityOptions): Promise<ActivityResult>;
  alive(): boolean;
  processId(): Promise<number | undefined>;
}

export interface CreateTerminalHostOptions {
  backend: TerminalBackend;
  tmuxSessionName: string;
  tmuxWindowName: string;
}

export interface CreateTerminalBackendDriverOptions {
  backend: TerminalBackend;
  tmuxSessionName: string;
}

export interface LiveTerminalSessionSummary {
  sessionId: string;
  cwd?: string;
  updatedAt?: string;
  pid?: number;
}

export interface TerminalBackendDriver {
  readonly backend: ResolvedTerminalBackend;
  createHost(windowName: string): TerminalHost;
  listLiveSessions(): Promise<LiveTerminalSessionSummary[]>;
  hasLiveSession(sessionId: string): Promise<boolean>;
  closeLiveSession(sessionId: string): Promise<boolean>;
  supportsLiveReconnect(): boolean;
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
  pid(): number | undefined;
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
  return createTerminalBackendDriver({
    backend: options.backend,
    tmuxSessionName: options.tmuxSessionName,
  }).createHost(options.tmuxWindowName);
}

export function createTerminalBackendDriver(
  options: CreateTerminalBackendDriverOptions,
): TerminalBackendDriver {
  const backend = resolveTerminalBackend(options.backend);
  if (backend === "tmux") {
    return new TmuxTerminalBackendDriver(options.tmuxSessionName);
  }
  return new XtermTerminalBackendDriver();
}

class TmuxTerminalBackendDriver implements TerminalBackendDriver {
  readonly backend = "tmux" as const;

  constructor(private readonly sessionName: string) {}

  createHost(windowName: string): TerminalHost {
    return new TmuxTerminalHost(this.sessionName, windowName);
  }

  async listLiveSessions(): Promise<LiveTerminalSessionSummary[]> {
    const windows = await listWindows(this.sessionName);
    return windows.map((window) => ({
      sessionId: window.windowName,
      cwd: window.paneCurrentPath,
      updatedAt: parseTmuxActivity(window.windowActivity),
      pid: window.panePid,
    }));
  }

  async hasLiveSession(sessionId: string): Promise<boolean> {
    return (await Session.find(this.sessionName, sessionId)) !== null;
  }

  async closeLiveSession(sessionId: string): Promise<boolean> {
    const found = await Session.find(this.sessionName, sessionId);
    if (!found) return false;
    await found.kill();
    return true;
  }

  supportsLiveReconnect(): boolean {
    return true;
  }
}

class XtermTerminalBackendDriver implements TerminalBackendDriver {
  readonly backend = "xterm" as const;

  createHost(_windowName: string): TerminalHost {
    return new XtermTerminalHost();
  }

  async listLiveSessions(): Promise<LiveTerminalSessionSummary[]> {
    return [];
  }

  async hasLiveSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  async closeLiveSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  supportsLiveReconnect(): boolean {
    return false;
  }
}

function parseTmuxActivity(activity?: string): string | undefined {
  if (!activity) return undefined;
  const epochSeconds = Number.parseInt(activity, 10);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return undefined;
  }
  return new Date(epochSeconds * 1000).toISOString();
}

class TmuxTerminalHost implements TerminalHost {
  readonly backend = "tmux" as const;

  private session: Session | null = null;

  constructor(
    private readonly sessionName: string,
    private readonly windowName: string,
  ) {}

  async start(command: string[], options: TerminalStartOptions): Promise<void> {
    this.session = await Session.newSession(
      this.sessionName,
      options.cols,
      options.rows,
      options.cwd,
      command,
      this.windowName,
    );
    // tmux reads pane_current_path from /proc/<pane_pid>/cwd. Immediately
    // after new-session/new-window the child may not have exec'd yet, so
    // that path can transiently reflect the tmux server's cwd instead of
    // the pane's. Poll briefly so consumers that call currentPath() right
    // after start observe the intended working directory.
    if (options.cwd) {
      await this.waitForPaneCwd(options.cwd, 300);
    }
  }

  private async waitForPaneCwd(expected: string, maxWaitMs: number): Promise<void> {
    if (!this.session) return;
    const normalized = expected.replace(/\/+$/, "") || "/";
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const actual = await this.session.currentPath().catch(() => "");
      if (actual === normalized) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.session.kill().catch(() => {});
    this.session = null;
  }

  async detach(): Promise<void> {
    // Drop the reference without killing the tmux window.
    this.session = null;
  }

  async reattach(windowName: string): Promise<boolean> {
    const existing = await Session.find(this.sessionName, windowName);
    if (!existing) return false;
    this.session = existing;
    return true;
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

  async currentPath(): Promise<string | undefined> {
    if (!this.session) return undefined;
    return this.session.currentPath().catch(() => undefined);
  }

  async awaitIdle(options?: PaneActivityOptions): Promise<ActivityResult> {
    if (!this.session) throw new Error("tmux terminal is not started");
    return this.session.awaitIdle(options);
  }

  alive(): boolean {
    return this.session !== null && this.session.isAlive;
  }

  async processId(): Promise<number | undefined> {
    if (!this.session) return undefined;
    return this.session.panePID().catch(() => undefined);
  }
}

class XtermTerminalHost implements TerminalHost {
  readonly backend = "xterm" as const;

  private transport: PtyTransport | null = null;
  private terminal: HeadlessTerminal | null = null;
  private serializeAddon: SerializeAddon | null = null;
  private outputDrain: Promise<void> = Promise.resolve();
  private exited = false;
  private cwd: string | undefined;

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
    this.cwd = options.cwd;
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

  async detach(): Promise<void> {
    // xterm PTYs are in-process; detach is the same as stop.
    await this.stop();
  }

  async reattach(_windowName: string): Promise<boolean> {
    // xterm PTYs can't outlive the process. Reattach only works via the daemon.
    return false;
  }

  async send(input: string): Promise<void> {
    if (!this.transport) throw new Error("xterm terminal is not started");
    if (!this.terminal) throw new Error("xterm terminal is not started");
    await this.outputDrain.catch(() => {});
    if (input) {
      for (const char of input) {
        this.terminal.input(char);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.terminal.input("\r");
  }

  async interrupt(): Promise<void> {
    if (!this.transport) throw new Error("xterm terminal is not started");
    if (!this.terminal) throw new Error("xterm terminal is not started");
    await this.outputDrain.catch(() => {});
    this.terminal.input("\u0003");
  }

  async capture(): Promise<string> {
    if (!this.serializeAddon) throw new Error("xterm terminal is not started");
    await this.outputDrain;
    return this.serializeAddon.serialize();
  }

  async currentPath(): Promise<string | undefined> {
    return this.cwd;
  }

  async awaitIdle(options?: PaneActivityOptions): Promise<ActivityResult> {
    return awaitPaneIdle(() => this.capture(), options);
  }

  alive(): boolean {
    return this.transport !== null && this.transport.alive() && !this.exited;
  }

  async processId(): Promise<number | undefined> {
    return this.transport?.pid();
  }
}

async function createPtyTransport(): Promise<PtyTransport> {
  if (resolveXtermTransportKind() === "bun-terminal") {
    return new BunTerminalTransport();
  }
  return new NodePtyTransport();
}

function isOsPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

class NodePtyTransport implements PtyTransport {
  private pty: IPty | null = null;
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
    let ptyModule: typeof import("node-pty");
    try {
      ptyModule = await import("node-pty");
    } catch (error) {
      throw new Error(
        "xterm backend under Node requires the optional dependency 'node-pty'. Install it or run with Bun so Bun.Terminal can be used instead.",
        { cause: error },
      );
    }
    const pty = getModuleExports(ptyModule) as typeof import("node-pty");
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
    if (this.pty === null || !this.aliveFlag) return false;
    // node-pty's onExit can lag when a child process is SIGKILL'd and still
    // holds open stdio via grandchildren. Cross-check by probing the pid.
    if (!isOsPidAlive(this.pty.pid)) {
      this.aliveFlag = false;
      return false;
    }
    return true;
  }

  pid(): number | undefined {
    return this.pty?.pid;
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
    if (this.terminal === null || this.terminal.closed || !this.aliveFlag) {
      return false;
    }
    const pid = (this.process as { pid?: number } | null)?.pid;
    if (!isOsPidAlive(pid)) {
      this.aliveFlag = false;
      return false;
    }
    return true;
  }

  pid(): number | undefined {
    return (this.process as { pid?: number } | null)?.pid;
  }
}

export const __test = {
  createXtermTerminalHost() {
    return new XtermTerminalHost();
  },
};
