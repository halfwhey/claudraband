import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Tailer } from "./parser";
import {
  parseNativePermissionPrompt,
  pickDefaultNativePermissionOption,
} from "./inspect";
import type { Event } from "../wrap/event";
import type { Wrapper } from "../wrap/wrapper";
import {
  createTerminalHost,
  type TerminalBackend,
  type TerminalHost,
} from "../terminal";
import type { ActivityResult, PaneActivityOptions } from "../terminal/activity";
import { resolveClaudeLaunchCommand } from "./resolve";

export interface ClaudeConfig {
  claudeArgs: string[];
  claudeExecutable?: string;
  model: string;
  permissionMode: string;
  autoAcceptStartupPrompts?: boolean;
  workingDir: string;
  terminalBackend: TerminalBackend;
  tmuxSession: string;
  paneWidth: number;
  paneHeight: number;
}

export type ClaudeStartupState = "ready" | "blocked_native_prompt";

export function normalizeSessionCwd(cwd: string): string {
  return resolve(cwd);
}

function escapeProjectDirName(cwd: string): string {
  return normalizeSessionCwd(cwd).replace(/[^A-Za-z0-9-]/g, "-");
}

export function sessionPath(cwd: string, sessionID: string): string {
  const home = homedir();
  const escaped = escapeProjectDirName(cwd);
  return join(home, ".claude", "projects", escaped, `${sessionID}.jsonl`);
}

export class ClaudeStartupError extends Error {
  readonly paneSnapshot: string;

  constructor(message: string, paneSnapshot = "") {
    super(message);
    this.name = "ClaudeStartupError";
    this.paneSnapshot = paneSnapshot;
  }
}

function stripAnsi(value: string): string {
  return value.replace(
    // Matches common CSI/OSC ANSI escape sequences.
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g,
    "",
  );
}

function summarizePaneSnapshot(pane: string): string {
  const cleaned = stripAnsi(pane)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  return cleaned.slice(-4).join(" | ").slice(0, 280);
}

export function buildClaudeStartupError(paneSnapshot = ""): ClaudeStartupError {
  const summary = summarizePaneSnapshot(paneSnapshot);
  return new ClaudeStartupError(
    summary
      ? `Claude exited during startup. Last pane output: ${summary}`
      : "Claude exited during startup.",
    paneSnapshot,
  );
}

export class ClaudeWrapper implements Wrapper {
  private cfg: ClaudeConfig;
  private terminal: TerminalHost | null = null;
  private tailer: Tailer | null = null;
  private _claudeSessionId = "";
  private _signal: AbortSignal | null = null;
  private abortController: AbortController | null = null;
  private eventIterable: AsyncGenerator<Event> | null = null;
  private _startupState: ClaudeStartupState = "ready";

  constructor(cfg: ClaudeConfig) {
    this.cfg = {
      ...cfg,
      workingDir: normalizeSessionCwd(cfg.workingDir),
    };
  }

  name(): string {
    return "claude";
  }

  model(): string {
    return this.cfg.model;
  }

  setModel(model: string): void {
    this.cfg.model = model;
  }

  setPermissionMode(mode: string): void {
    this.cfg.permissionMode = mode;
  }

  /** The Claude Code session UUID used for the JSONL file. */
  get claudeSessionId(): string {
    return this._claudeSessionId;
  }

  get workingDir(): string {
    return this.cfg.workingDir;
  }

  get startupState(): ClaudeStartupState {
    return this._startupState;
  }

  async start(signal: AbortSignal): Promise<void> {
    this._claudeSessionId = randomUUID();
    this._signal = signal;
    const cmd = this.buildCmd("--session-id", this._claudeSessionId);
    await this.spawnAndTail(signal, cmd);
  }

  /** Resume an existing Claude Code session by its UUID. */
  async startResume(claudeSessionId: string, signal: AbortSignal): Promise<void> {
    this._claudeSessionId = claudeSessionId;
    this._signal = signal;

    // Try to reattach to a still-running tmux window first.
    const terminal = createTerminalHost({
      backend: this.cfg.terminalBackend,
      tmuxSessionName: this.cfg.tmuxSession,
      tmuxWindowName: claudeSessionId,
    });
    const reattached = await terminal.reattach(claudeSessionId);

    if (reattached) {
      // The process is still alive in tmux. Just reconnect the tailer.
      this.terminal = terminal;
      this.abortController = new AbortController();
      signal.addEventListener("abort", () => {
        this.abortController?.abort();
      });
      await this.syncWorkingDirFromTerminal();
      const jsonlPath = sessionPath(this.cfg.workingDir, claudeSessionId);
      let tailOffset = 0;
      if (existsSync(jsonlPath)) {
        tailOffset = statSync(jsonlPath).size;
      }
      this.tailer = new Tailer(jsonlPath, tailOffset);
      this.eventIterable = this.tailer.events();

      const ac = this.abortController;
      const tailer = this.tailer;
      const term = this.terminal;
      ac.signal.addEventListener("abort", async () => {
        tailer.close();
        await term?.stop().catch(() => {});
      }, { once: true });
      return;
    }

    // No live process -- spawn a new Claude Code with --resume.
    const jsonlPath = sessionPath(this.cfg.workingDir, claudeSessionId);
    let tailOffset = 0;
    if (existsSync(jsonlPath)) {
      tailOffset = statSync(jsonlPath).size;
    }
    const cmd = existsSync(jsonlPath)
      ? this.buildCmd("--resume", claudeSessionId)
      : this.buildCmd("--session-id", claudeSessionId);
    await this.spawnAndTail(signal, cmd, tailOffset);
  }

  /**
   * Restart Claude Code with updated config (e.g. after a permission mode
   * change). Stops the current terminal host and re-spawns with --resume.
   */
  async restart(): Promise<void> {
    if (!this._signal) throw new Error("claude: not started");
    // Close tailer and stop the host, but don't abort the outer controller.
    this.tailer?.close();
    if (this.terminal) {
      await this.terminal.stop().catch(() => {});
    }
    this.terminal = null;
    this.tailer = null;
    this.eventIterable = null;

    // Use --resume if the JSONL file exists (session has been used),
    // otherwise --session-id to create a fresh session with the same UUID.
    const jsonlPath = sessionPath(this.cfg.workingDir, this._claudeSessionId);
    let tailOffset = 0;
    if (existsSync(jsonlPath)) {
      tailOffset = statSync(jsonlPath).size;
    }
    const cmd = existsSync(jsonlPath)
      ? this.buildCmd("--resume", this._claudeSessionId)
      : this.buildCmd("--session-id", this._claudeSessionId);
    await this.spawnAndTail(this._signal, cmd, tailOffset);
  }

  private buildCmd(...extra: string[]): string[] {
    const cmd = [
      ...resolveClaudeLaunchCommand(this.cfg.claudeExecutable),
      "--model",
      this.cfg.model,
      ...this.cfg.claudeArgs,
    ];
    if (this.cfg.permissionMode && this.cfg.permissionMode !== "default") {
      cmd.push("--permission-mode", this.cfg.permissionMode);
    }
    cmd.push(...extra);
    return cmd;
  }

  private async spawnAndTail(signal: AbortSignal, cmd: string[], tailOffset = 0): Promise<void> {
    this.abortController = new AbortController();
    this.terminal = createTerminalHost({
      backend: this.cfg.terminalBackend,
      tmuxSessionName: this.cfg.tmuxSession,
      tmuxWindowName: this._claudeSessionId,
    });

    signal.addEventListener("abort", () => {
      this.abortController?.abort();
    });

    await this.terminal.start(cmd, {
      cwd: this.cfg.workingDir,
      cols: this.cfg.paneWidth,
      rows: this.cfg.paneHeight,
      signal,
    });
    await this.syncWorkingDirFromTerminal();

    // Wait for Claude Code to be ready (showing INSERT mode or ❯ prompt)
    this._startupState = await this.waitForReady(signal);

    const jsonlPath = sessionPath(this.cfg.workingDir, this._claudeSessionId);
    this.tailer = new Tailer(jsonlPath, tailOffset);
    this.eventIterable = this.tailer.events();

    const ac = this.abortController;
    const terminal = this.terminal;
    const tailer = this.tailer;

    ac.signal.addEventListener("abort", async () => {
      tailer.close();
      await terminal?.stop().catch(() => {});
    }, { once: true });
  }

  private async syncWorkingDirFromTerminal(): Promise<void> {
    const actualWorkingDir = await this.terminal?.currentPath();
    if (actualWorkingDir) {
      this.cfg.workingDir = normalizeSessionCwd(actualWorkingDir);
    }
  }

  /**
   * Poll the terminal until Claude Code is ready to accept input, or until a
   * startup-native prompt is visible. By default startup prompts block session
   * readiness; callers can opt into auto-accept for unattended flows.
   */
  private async waitForReady(signal: AbortSignal): Promise<ClaudeStartupState> {
    const MAX_WAIT_MS = 15_000;
    const POLL_MS = 300;
    const start = Date.now();
    let lastStartupPromptFingerprint = "";
    let lastPaneSnapshot = "";

    while (Date.now() - start < MAX_WAIT_MS) {
      if (signal.aborted) return "ready";
      if (!this.terminal?.alive()) {
        throw buildClaudeStartupError(lastPaneSnapshot);
      }
      try {
        const pane = await this.terminal!.capture();
        lastPaneSnapshot = pane;
        if (pane.includes("INSERT") || pane.includes("NORMAL")) {
          return "ready";
        }
        const startupPrompt = parseNativePermissionPrompt(pane);
        if (startupPrompt) {
          if (!this.cfg.autoAcceptStartupPrompts) {
            return "blocked_native_prompt";
          }
          const startupPromptFingerprint = `${startupPrompt.question}\n${startupPrompt.options
            .map((option) => `${option.number}:${option.label}`)
            .join("\n")}`;
          const allowOption = pickDefaultNativePermissionOption(startupPrompt);
          if (
            allowOption
            && lastStartupPromptFingerprint !== startupPromptFingerprint
          ) {
            await this.terminal!.send(allowOption).catch(() => {});
            lastStartupPromptFingerprint = startupPromptFingerprint;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }
        lastStartupPromptFingerprint = "";
      } catch {
        if (!this.terminal?.alive()) {
          throw buildClaudeStartupError(lastPaneSnapshot);
        }
        // pane not ready yet
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (!this.terminal?.alive()) {
      throw buildClaudeStartupError(lastPaneSnapshot);
    }
    if (lastPaneSnapshot && parseNativePermissionPrompt(lastPaneSnapshot)) {
      return "blocked_native_prompt";
    }
    return "ready";
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    if (this.terminal) {
      await this.terminal.stop();
    }
  }

  /** Disconnect without killing the process. The terminal stays alive. */
  async detach(): Promise<void> {
    this.tailer?.close();
    this.tailer = null;
    this.eventIterable = null;
    if (this.terminal) {
      await this.terminal.detach();
    }
    this.terminal = null;
  }

  /** Check if the underlying terminal process is still running. */
  isProcessAlive(): boolean {
    return this.terminal !== null && this.terminal.alive();
  }

  /**
   * Check if a Claude Code session has a live process without attaching.
   * Only meaningful for tmux backend -- xterm processes can't outlive the CLI.
   */
  static async hasLiveProcess(
    tmuxSessionName: string,
    claudeSessionId: string,
  ): Promise<boolean> {
    const { Session } = await import("../tmuxctl");
    const found = await Session.find(tmuxSessionName, claudeSessionId);
    return found !== null;
  }

  static async stopLiveProcess(
    tmuxSessionName: string,
    claudeSessionId: string,
  ): Promise<boolean> {
    const { Session } = await import("../tmuxctl");
    const found = await Session.find(tmuxSessionName, claudeSessionId);
    if (!found) return false;
    await found.kill();
    return true;
  }

  async send(input: string): Promise<void> {
    if (!this.terminal) throw new Error("claude: not started");
    await this.terminal.send(input);
  }

  async interrupt(): Promise<void> {
    if (!this.terminal) throw new Error("claude: not started");
    await this.terminal.interrupt();
  }

  /** Capture the current visible content of the terminal. */
  async capturePane(): Promise<string> {
    if (!this.terminal) throw new Error("claude: not started");
    return this.terminal.capture();
  }

  async awaitIdle(options?: PaneActivityOptions): Promise<ActivityResult> {
    if (!this.terminal) throw new Error("claude: not started");
    return this.terminal.awaitIdle(options);
  }

  async processId(): Promise<number | undefined> {
    return this.terminal?.processId();
  }

  alive(): boolean {
    return this.terminal !== null && this.terminal.alive();
  }

  async *events(): AsyncGenerator<Event> {
    if (this.eventIterable) {
      yield* this.eventIterable;
    }
  }
}

export interface ParsedClaudeArgs {
  passthroughArgs: string[];
  model?: string;
  permissionMode?: string;
}

export function parseClaudeArgs(args: string[]): ParsedClaudeArgs {
  const passthroughArgs: string[] = [];
  let model: string | undefined;
  let permissionMode: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
      continue;
    }
    if (arg === "--permission-mode" && i + 1 < args.length) {
      permissionMode = args[++i];
      continue;
    }
    passthroughArgs.push(arg);
  }

  return { passthroughArgs, model, permissionMode };
}
