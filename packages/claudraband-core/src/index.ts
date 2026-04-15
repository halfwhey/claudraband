import { open, readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import {
  ClaudeWrapper,
  hasPendingNativePrompt,
  hasPendingQuestion,
  parseClaudeArgs,
  parseLineEvents,
  parseNativePermissionPrompt,
  resolveTerminalBackend,
  sessionPath,
  type TerminalBackend,
} from "./claude";
import {
  createTerminalBackendDriver,
  type ResolvedTerminalBackend,
  type TerminalBackendDriver,
} from "./terminal";
import type { Event as ClaudrabandEvent } from "./wrap/event";
import { EventKind } from "./wrap/event";
import type { Wrapper } from "./wrap/wrapper";
import {
  deleteSessionRecord,
  isPidAlive,
  listKnownSessionRecords,
  listSessionRecords,
  normalizeServerUrl,
  readKnownSessionRecord,
  readSessionRecord,
  type SessionOwnerRecord,
  type SessionRecord,
  writeKnownSessionRecord,
  writeSessionRecord,
} from "./session-registry";

const DEFAULT_PANE_WIDTH = 120;
const DEFAULT_PANE_HEIGHT = 40;
const IDLE_TIMEOUT_MS = 3000;
const SHARED_TMUX_SESSION = "claudraband-working-session";
const READY_MODE_PROMPT_RE = /(?:^|[^A-Za-z0-9_])(INSERT|NORMAL)\s*$/;

export { EventKind };
export { hasPendingNativePrompt };
export { hasPendingQuestion };
export { parseClaudeArgs };
export { resolveTerminalBackend };
export { sessionPath };
export { awaitPaneIdle } from "./terminal/activity";
export type { PaneActivityOptions, ActivityResult } from "./terminal/activity";
export type { ClaudrabandEvent };
export type { TerminalBackend };
export type { ResolvedTerminalBackend };
export type { SessionOwnerRecord };

const SHARED_TMUX_SESSION_NAME = "claudraband-working-session";

/** Check if a Claude Code session has a live tmux process. */
export async function hasLiveProcess(sessionId: string): Promise<boolean> {
  return createTerminalBackendDriver({
    backend: "tmux",
    tmuxSessionName: SHARED_TMUX_SESSION_NAME,
  }).hasLiveSession(sessionId);
}

export async function closeLiveProcess(sessionId: string): Promise<boolean> {
  return createTerminalBackendDriver({
    backend: "tmux",
    tmuxSessionName: SHARED_TMUX_SESSION_NAME,
  }).closeLiveSession(sessionId);
}

export type PermissionMode =
  | "default"
  | "plan"
  | "auto"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions";

export type ToolKind =
  | "read"
  | "edit"
  | "execute"
  | "search"
  | "fetch"
  | "think"
  | "other";

export interface ClaudrabandLogger {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface ClaudrabandContentBlock {
  type: "text";
  text: string;
}

export interface ClaudrabandPermissionOption {
  kind: "allow_once" | "reject_once";
  optionId: string;
  name: string;
  textInput?: boolean;
}

export interface ClaudrabandPermissionRequest {
  source: "native_prompt" | "ask_user_question";
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: ToolKind;
  content: ClaudrabandContentBlock[];
  options: ClaudrabandPermissionOption[];
}

export type ClaudrabandPermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "text"; text: string }
  | { outcome: "deferred" }
  | { outcome: "cancelled" };

export interface ClaudrabandOptions {
  cwd?: string;
  claudeArgs?: string[];
  claudeExecutable?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowTextResponses?: boolean;
  terminalBackend?: TerminalBackend;
  paneWidth?: number;
  paneHeight?: number;
  logger?: ClaudrabandLogger;
  onPermissionRequest?: (
    request: ClaudrabandPermissionRequest,
  ) => Promise<ClaudrabandPermissionDecision>;
  sessionOwner?: SessionOwnerRecord;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
  backend: ResolvedTerminalBackend;
  source: "live" | "history";
  alive: boolean;
  reattachable: boolean;
  owner: SessionOwnerRecord;
}

export interface PromptResult {
  stopReason: "end_turn" | "cancelled";
}

export interface ClaudrabandSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly backend: ResolvedTerminalBackend;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  events(): AsyncIterable<ClaudrabandEvent>;
  prompt(text: string): Promise<PromptResult>;
  awaitTurn(): Promise<PromptResult>;
  sendAndAwaitTurn(text: string): Promise<PromptResult>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  /** Disconnect without killing the process. */
  detach(): Promise<void>;
  isProcessAlive(): boolean;
  capturePane(): Promise<string>;
  hasPendingInput(): Promise<{ pending: boolean; source: "none" | "terminal" }>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  flushEvents(): Promise<void>;
}

export interface Claudraband {
  startSession(options?: ClaudrabandOptions): Promise<ClaudrabandSession>;
  resumeSession(
    sessionId: string,
    options?: ClaudrabandOptions,
  ): Promise<ClaudrabandSession>;
  listSessions(cwd?: string): Promise<SessionSummary[]>;
  inspectSession(sessionId: string, cwd?: string): Promise<SessionSummary | null>;
  closeSession(sessionId: string): Promise<boolean>;
  replaySession(sessionId: string, cwd: string): Promise<ClaudrabandEvent[]>;
}

export const MODEL_OPTIONS = [
  { value: "haiku", name: "Haiku", description: "Fast and lightweight" },
  {
    value: "sonnet",
    name: "Sonnet",
    description: "Balanced speed and intelligence",
  },
  { value: "opus", name: "Opus", description: "Most capable" },
] as const;

export const PERMISSION_MODES = [
  { id: "default", name: "Default", description: "Ask before tool use" },
  { id: "plan", name: "Plan", description: "Plan-only mode, no edits" },
  { id: "auto", name: "Auto", description: "Bypass permission checks" },
  {
    id: "acceptEdits",
    name: "Accept Edits",
    description: "Auto-accept file edits",
  },
  { id: "dontAsk", name: "Don't Ask", description: "Skip all confirmations" },
  {
    id: "bypassPermissions",
    name: "Bypass Permissions",
    description: "Dangerously Skip Permissions",
  },
] as const;

export const TERMINAL_BACKENDS = [
  {
    id: "auto",
    name: "Auto",
    description: "Prefer tmux, then fall back to headless xterm",
  },
  {
    id: "tmux",
    name: "tmux",
    description: "Run Claude Code inside a tmux session",
  },
  {
    id: "xterm",
    name: "xterm",
    description: "Run Claude Code in a headless xterm-backed PTY",
  },
] as const;

interface Subscriber {
  queue: ClaudrabandEvent[];
  resolvers: Array<(result: IteratorResult<ClaudrabandEvent>) => void>;
  closed: boolean;
  inFlight: number;
}

interface PromptWaiter {
  text: string;
  matchedUserEcho: boolean;
  pendingTools: number;
  gotResponse: boolean;
  turnEnded: boolean;
  inputDeferred: boolean;
  lastPendingTool: PendingTool | null;
  consecutiveIdles: number;
  waiters: Set<() => void>;
}

interface PendingTool {
  name: string;
  id: string;
  input: string;
}

type NativePermissionHandling =
  | "none"
  | "deferred"
  | "handled"
  | "consumed"
  | "pending_clear";

function isRejectingNativeOption(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized.startsWith("no") || normalized.startsWith("reject");
}

interface AskUserQuestionOption {
  label: string;
  description: string;
}

interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

interface AskUserQuestion {
  questions: AskUserQuestionItem[];
}

function makeDefaultLogger(): ClaudrabandLogger {
  const noop = () => {};
  return {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
  };
}

function normalizeOptions(
  defaults: ClaudrabandOptions,
  options: ClaudrabandOptions | undefined,
): Required<Omit<ClaudrabandOptions, "onPermissionRequest" | "sessionOwner">> & {
  onPermissionRequest?: ClaudrabandOptions["onPermissionRequest"];
  sessionOwner?: ClaudrabandOptions["sessionOwner"];
} {
  const parsedClaudeArgs = parseClaudeArgs(
    options?.claudeArgs ?? defaults.claudeArgs ?? [],
  );
  return {
    cwd: options?.cwd ?? defaults.cwd ?? process.cwd(),
    claudeArgs: parsedClaudeArgs.passthroughArgs,
    claudeExecutable: options?.claudeExecutable ?? defaults.claudeExecutable ?? "",
    model:
      options?.model ??
      parsedClaudeArgs.model ??
      defaults.model ??
      "sonnet",
    permissionMode:
      options?.permissionMode ??
      (parsedClaudeArgs.permissionMode as PermissionMode | undefined) ??
      defaults.permissionMode ??
      "default",
    allowTextResponses:
      options?.allowTextResponses ??
      defaults.allowTextResponses ??
      false,
    terminalBackend: options?.terminalBackend ?? defaults.terminalBackend ?? "auto",
    paneWidth: options?.paneWidth ?? defaults.paneWidth ?? DEFAULT_PANE_WIDTH,
    paneHeight:
      options?.paneHeight ?? defaults.paneHeight ?? DEFAULT_PANE_HEIGHT,
    logger: options?.logger ?? defaults.logger ?? makeDefaultLogger(),
    onPermissionRequest:
      options?.onPermissionRequest ?? defaults.onPermissionRequest,
    ...(
      options?.sessionOwner ?? defaults.sessionOwner
        ? { sessionOwner: options?.sessionOwner ?? defaults.sessionOwner }
        : {}
    ),
  };
}

export function createClaudraband(
  defaults: ClaudrabandOptions = {},
): Claudraband {
  return new ClaudrabandRuntime(defaults);
}

class ClaudrabandRuntime implements Claudraband {
  private defaults: ClaudrabandOptions;

  constructor(defaults: ClaudrabandOptions) {
    this.defaults = defaults;
  }

  async startSession(options?: ClaudrabandOptions): Promise<ClaudrabandSession> {
    const cfg = normalizeOptions(this.defaults, options);
    const backend = resolveTerminalBackend(cfg.terminalBackend);
    const wrapper = new ClaudeWrapper({
      model: cfg.model,
      claudeArgs: cfg.claudeArgs,
      claudeExecutable: cfg.claudeExecutable || undefined,
      permissionMode: cfg.permissionMode,
      terminalBackend: cfg.terminalBackend,
      workingDir: cfg.cwd,
      tmuxSession: SHARED_TMUX_SESSION,
      paneWidth: cfg.paneWidth,
      paneHeight: cfg.paneHeight,
    });
    const lifetime = new AbortController();
    await wrapper.start(lifetime.signal);
    const session = new ClaudrabandSessionImpl(
      wrapper,
      wrapper.claudeSessionId,
      wrapper.workingDir,
      backend,
      cfg.model,
      cfg.permissionMode,
      cfg.allowTextResponses,
      cfg.logger,
      cfg.onPermissionRequest,
      lifetime,
      cfg.sessionOwner,
    );
    await session.syncSessionRecord();
    return session;
  }

  async resumeSession(
    sessionId: string,
    options?: ClaudrabandOptions,
  ): Promise<ClaudrabandSession> {
    const cfg = normalizeOptions(this.defaults, options);
    const backend = resolveTerminalBackend(cfg.terminalBackend);
    const wrapper = new ClaudeWrapper({
      model: cfg.model,
      claudeArgs: cfg.claudeArgs,
      claudeExecutable: cfg.claudeExecutable || undefined,
      permissionMode: cfg.permissionMode,
      terminalBackend: cfg.terminalBackend,
      workingDir: cfg.cwd,
      tmuxSession: SHARED_TMUX_SESSION,
      paneWidth: cfg.paneWidth,
      paneHeight: cfg.paneHeight,
    });
    const lifetime = new AbortController();
    await wrapper.startResume(sessionId, lifetime.signal);
    const session = new ClaudrabandSessionImpl(
      wrapper,
      sessionId,
      wrapper.workingDir,
      backend,
      cfg.model,
      cfg.permissionMode,
      cfg.allowTextResponses,
      cfg.logger,
      cfg.onPermissionRequest,
      lifetime,
      cfg.sessionOwner,
    );
    await session.syncSessionRecord();
    return session;
  }

  listSessions(cwd?: string): Promise<SessionSummary[]> {
    return discoverSessions(cwd);
  }

  inspectSession(sessionId: string, cwd?: string): Promise<SessionSummary | null> {
    return inspectSession(sessionId, cwd);
  }

  closeSession(sessionId: string): Promise<boolean> {
    return closeSessionByRecord(sessionId);
  }

  async replaySession(
    sessionId: string,
    cwd: string,
  ): Promise<ClaudrabandEvent[]> {
    let data: string;
    try {
      data = await readFile(sessionPath(cwd, sessionId), "utf-8");
    } catch {
      return [];
    }

    const events: ClaudrabandEvent[] = [];
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      events.push(...parseLineEvents(line));
    }
    return events;
  }
}

interface SessionWrapper extends Wrapper {
  capturePane(): Promise<string>;
  setModel(model: string): void;
  setPermissionMode(mode: string): void;
  restart(): Promise<void>;
  detach(): Promise<void>;
  isProcessAlive(): boolean;
  processId(): Promise<number | undefined>;
}

class ClaudrabandSessionImpl implements ClaudrabandSession {
  private wrapper: SessionWrapper;
  private logger: ClaudrabandLogger;
  private onPermissionRequest?: ClaudrabandOptions["onPermissionRequest"];
  private lifetime: AbortController;
  private promptAbortController: AbortController | null = null;
  private subscribers = new Set<Subscriber>();
  private stopped = false;
  private pumpDone = false;
  private pumpError: unknown = null;
  private activePrompt: PromptWaiter | null = null;
  private readonly pumpPromise: Promise<void>;
  private _model: string;
  private _permissionMode: PermissionMode;
  private allowTextResponses: boolean;
  private sessionOwner?: SessionOwnerRecord;
  private lastNativePermissionFingerprint: string | null = null;
  private lastNativePermissionOutcome: NativePermissionHandling = "none";

  constructor(
    wrapper: SessionWrapper,
    readonly sessionId: string,
    readonly cwd: string,
    readonly backend: ResolvedTerminalBackend,
    model: string,
    permissionMode: PermissionMode,
    allowTextResponses: boolean,
    logger: ClaudrabandLogger,
    onPermissionRequest: ClaudrabandOptions["onPermissionRequest"],
    lifetime: AbortController,
    sessionOwner?: SessionOwnerRecord,
  ) {
    this.wrapper = wrapper;
    this._model = model;
    this._permissionMode = permissionMode;
    this.allowTextResponses = allowTextResponses;
    this.logger = logger;
    this.onPermissionRequest = onPermissionRequest;
    this.lifetime = lifetime;
    this.sessionOwner = sessionOwner;
    this.pumpPromise = this.pumpEvents();
  }

  get model(): string {
    return this._model;
  }

  get permissionMode(): PermissionMode {
    return this._permissionMode;
  }

  async prompt(text: string): Promise<PromptResult> {
    if (this.promptAbortController) {
      this.promptAbortController.abort();
    }

    const controller = new AbortController();
    this.promptAbortController = controller;

    if (!text) {
      controller.abort();
      this.promptAbortController = null;
      return { stopReason: "end_turn" };
    }

    const prompt = this.newPromptWaiter(text);
    this.activePrompt = prompt;

    this.logger.info("prompt received", "sid", this.sessionId, "length", text.length);

    // Handle any blocking prompt (e.g. trust folder) before sending text,
    // otherwise the prompt text goes to the blocking prompt instead of Claude.
    const startupState = await this.prepareForInput(text);
    if (startupState === "blocked") {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "end_turn" };
    }
    if (startupState === "cancelled") {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "cancelled" };
    }

    if (startupState !== "consumed") {
      await this.wrapper.send(text);
    }

    try {
      const stopReason = await this.waitForPromptCompletion(prompt, controller.signal);
      this.logger.info(
        "prompt completed",
        "sid",
        this.sessionId,
        "stop_reason",
        stopReason,
      );
      return { stopReason };
    } finally {
      if (this.activePrompt === prompt) {
        this.activePrompt = null;
      }
      if (this.promptAbortController === controller) {
        this.promptAbortController = null;
      }
    }
  }

  async awaitTurn(): Promise<PromptResult> {
    if (this.promptAbortController) {
      this.promptAbortController.abort();
    }

    const controller = new AbortController();
    this.promptAbortController = controller;

    // Create a waiter that skips user echo matching — there's no outgoing
    // message to echo, we just want to drain the current turn (handling
    // any pending permissions/questions along the way).
    const prompt = this.newPromptWaiter("");
    prompt.matchedUserEcho = true;
    this.activePrompt = prompt;

    // Handle any blocking prompt before waiting for a turn.
    const startupState = await this.prepareForInput(null);
    if (startupState === "blocked") {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "end_turn" };
    }
    if (startupState === "cancelled") {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "cancelled" };
    }

    if (await this.isReadyForFreshInput()) {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "end_turn" };
    }

    this.logger.info("awaitTurn", "sid", this.sessionId);

    try {
      const stopReason = await this.waitForPromptCompletion(prompt, controller.signal);
      this.logger.info("awaitTurn completed", "sid", this.sessionId, "stop_reason", stopReason);
      return { stopReason };
    } finally {
      if (this.activePrompt === prompt) {
        this.activePrompt = null;
      }
      if (this.promptAbortController === controller) {
        this.promptAbortController = null;
      }
    }
  }

  async sendAndAwaitTurn(text: string): Promise<PromptResult> {
    if (this.promptAbortController) {
      this.promptAbortController.abort();
    }

    const controller = new AbortController();
    this.promptAbortController = controller;

    const prompt = this.newPromptWaiter("");
    prompt.matchedUserEcho = true;
    this.activePrompt = prompt;

    // Handle any blocking prompt before sending text.
    const startupState = await this.prepareForInput(text);
    if (startupState === "blocked") {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "end_turn" };
    }
    if (startupState === "cancelled") {
      this.activePrompt = null;
      this.promptAbortController = null;
      return { stopReason: "cancelled" };
    }
    if (startupState === "consumed") {
      if (this.activePrompt === prompt) {
        this.activePrompt = null;
      }
      if (this.promptAbortController === controller) {
        this.promptAbortController = null;
      }
      return { stopReason: "end_turn" };
    }

    this.logger.info("sendAndAwaitTurn", "sid", this.sessionId, "length", text.length);
    await this.wrapper.send(text);

    try {
      const stopReason = await this.waitForPromptCompletion(prompt, controller.signal);
      this.logger.info(
        "sendAndAwaitTurn completed",
        "sid",
        this.sessionId,
        "stop_reason",
        stopReason,
      );
      return { stopReason };
    } finally {
      if (this.activePrompt === prompt) {
        this.activePrompt = null;
      }
      if (this.promptAbortController === controller) {
        this.promptAbortController = null;
      }
    }
  }

  send(text: string): Promise<void> {
    return this.wrapper.send(text);
  }

  private async prepareForInput(
    intendedText: string | null,
  ): Promise<"ready" | "blocked" | "consumed" | "cancelled"> {
    const handled = await this.pollNativePermission(null, intendedText);
    if (
      handled === "handled"
      || handled === "consumed"
      || handled === "pending_clear"
    ) {
      const ready = await this.waitForInsertMode();
      if (!ready) {
        return this.wrapper.isProcessAlive() ? "blocked" : "cancelled";
      }
      return handled === "consumed" ? "consumed" : "ready";
    }

    const stillBlocking = hasPendingNativePrompt(
      await this.wrapper.capturePane().catch(() => ""),
    );
    if (stillBlocking) {
      return "blocked";
    }
    return "ready";
  }

  async interrupt(): Promise<void> {
    this.promptAbortController?.abort();
    await this.wrapper.interrupt();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.promptAbortController?.abort();
    this.lifetime.abort();
    await this.wrapper.stop().catch(() => {});
    await this.pumpPromise.catch(() => {});
    this.closeSubscribers();
    await this.syncSessionRecord(false);
  }

  async detach(): Promise<void> {
    this.stopped = true;
    this.promptAbortController?.abort();
    await this.wrapper.detach();
    await this.pumpPromise.catch(() => {});
    this.closeSubscribers();
    await this.syncSessionRecord();
  }

  isProcessAlive(): boolean {
    return this.wrapper.isProcessAlive();
  }

  capturePane(): Promise<string> {
    return this.wrapper.capturePane();
  }

  async syncSessionRecord(alive = this.isProcessAlive()): Promise<void> {
    const existing = await readSessionRecord(this.sessionId);
    const known = await readKnownSessionRecord(this.sessionId);
    const transcriptPath = sessionPath(this.cwd, this.sessionId);
    const now = new Date().toISOString();
    const title =
      existing?.title
      ?? known?.title
      ?? await extractSessionTitle(transcriptPath)
      ?? undefined;
    const owner = alive
      ? await this.resolveSessionOwner()
      : existing?.owner ?? known?.owner ?? await this.resolveSessionOwner();

    await writeKnownSessionRecord({
      version: 1,
      sessionId: this.sessionId,
      cwd: this.cwd,
      backend: this.backend,
      title,
      createdAt: existing?.createdAt ?? known?.createdAt ?? now,
      updatedAt: now,
      transcriptPath,
      owner,
    });

    if (!alive) {
      await deleteSessionRecord(this.sessionId);
      return;
    }

    await writeSessionRecord({
      version: 1,
      sessionId: this.sessionId,
      cwd: this.cwd,
      backend: this.backend,
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastKnownAlive: alive,
      reattachable: alive && this.supportsReconnect(owner),
      transcriptPath,
      owner,
    });
  }

  private async resolveSessionOwner(): Promise<SessionOwnerRecord> {
    if (this.sessionOwner?.kind === "daemon") {
      return this.sessionOwner;
    }
    return {
      kind: "local",
      pid: await this.wrapper.processId().catch(() => undefined),
    };
  }

  private supportsReconnect(owner: SessionOwnerRecord): boolean {
    return owner.kind === "daemon" || this.backend === "tmux";
  }

  async hasPendingInput(): Promise<{ pending: boolean; source: "none" | "terminal" }> {
    const jsonlPath = sessionPath(this.cwd, this.sessionId);
    const pendingQuestion = await hasPendingQuestion(jsonlPath);
    const pendingNativePrompt = hasPendingNativePrompt(
      await this.wrapper.capturePane().catch(() => ""),
    );

    return {
      pending: pendingQuestion || pendingNativePrompt,
      source: pendingQuestion || pendingNativePrompt ? "terminal" : "none",
    };
  }

  private async isReadyForFreshInput(): Promise<boolean> {
    if (!this.wrapper.isProcessAlive()) {
      return false;
    }

    const jsonlPath = sessionPath(this.cwd, this.sessionId);
    if (await hasPendingQuestion(jsonlPath)) {
      return false;
    }
    if (await hasTranscriptTurnInProgress(jsonlPath)) {
      return false;
    }

    // If the transcript shows no turn in progress and no pending question,
    // the session is idle. The TUI mode indicator (INSERT/NORMAL) is not
    // required here -- it's a separate concern used at startup in
    // waitForReady and is brittle across TUI layouts and ANSI rendering.
    const pane = await this.wrapper.capturePane().catch(() => "");
    if (pane && hasPendingNativePrompt(pane)) {
      return false;
    }

    return true;
  }

  async setModel(model: string): Promise<void> {
    this._model = model;
    this.wrapper.setModel(model);
    await this.wrapper.send(`/model ${model}`);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this._permissionMode = mode;
    this.wrapper.setPermissionMode(mode);
    await this.wrapper.restart();
    await this.syncSessionRecord();
  }

  async flushEvents(): Promise<void> {
    while (true) {
      let pending = false;
      for (const subscriber of this.subscribers) {
        if (subscriber.queue.length > 0 || subscriber.inFlight > 0) {
          pending = true;
          break;
        }
      }
      if (!pending) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  async *events(): AsyncGenerator<ClaudrabandEvent> {
    const subscriber: Subscriber = {
      queue: [],
      resolvers: [],
      closed: false,
      inFlight: 0,
    };
    this.subscribers.add(subscriber);

    try {
      while (true) {
        if (subscriber.queue.length > 0) {
          const event = subscriber.queue.shift()!;
          subscriber.inFlight++;
          yield event;
          subscriber.inFlight = Math.max(0, subscriber.inFlight - 1);
          continue;
        }
        if (subscriber.closed) return;
        const result = await new Promise<IteratorResult<ClaudrabandEvent>>(
          (resolve) => {
            subscriber.resolvers.push(resolve);
          },
        );
        if (result.done) return;
        yield result.value;
        subscriber.inFlight = Math.max(0, subscriber.inFlight - 1);
      }
    } finally {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
    }
  }

  private emit(ev: ClaudrabandEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue;
      const resolver = subscriber.resolvers.shift();
      if (resolver) {
        subscriber.inFlight++;
        resolver({ value: ev, done: false });
      } else {
        subscriber.queue.push(ev);
      }
    }
  }

  private newPromptWaiter(text: string): PromptWaiter {
    return {
      text,
      matchedUserEcho: false,
      pendingTools: 0,
      gotResponse: false,
      turnEnded: false,
      inputDeferred: false,
      lastPendingTool: null,
      consecutiveIdles: 0,
      waiters: new Set(),
    };
  }

  private notifyPrompt(prompt: PromptWaiter | null): void {
    if (!prompt) return;
    for (const wake of prompt.waiters) {
      wake();
    }
    prompt.waiters.clear();
  }

  private async pumpEvents(): Promise<void> {
    try {
      for await (const ev of this.wrapper.events()) {
        this.emit(ev);
        await this.handlePromptEvent(ev);
      }
    } catch (err) {
      this.pumpError = err;
      this.logger.error("session event pump failed", "sid", this.sessionId, err);
    } finally {
      this.pumpDone = true;
      this.notifyPrompt(this.activePrompt);
      this.closeSubscribers();
    }
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      for (const resolver of subscriber.resolvers) {
        resolver({ value: undefined, done: true } as IteratorResult<ClaudrabandEvent>);
      }
      subscriber.resolvers = [];
    }
    this.subscribers.clear();
  }

  private async handlePromptEvent(ev: ClaudrabandEvent): Promise<void> {
    const prompt = this.activePrompt;
    if (!prompt) return;

    if (!prompt.matchedUserEcho) {
      if (ev.kind === EventKind.UserMessage && ev.text === prompt.text) {
        prompt.matchedUserEcho = true;
        this.notifyPrompt(prompt);
      }
      return;
    }

    switch (ev.kind) {
      case EventKind.AssistantText:
        prompt.gotResponse = true;
        break;
      case EventKind.ToolCall:
        prompt.pendingTools++;
        if (ev.toolName === "AskUserQuestion") {
          prompt.inputDeferred = await this.handleUserQuestion(ev);
          prompt.pendingTools = Math.max(0, prompt.pendingTools - 1);
          prompt.gotResponse = true;
        } else {
          prompt.lastPendingTool = {
            name: ev.toolName,
            id: ev.toolID,
            input: ev.toolInput,
          };
        }
        break;
      case EventKind.ToolResult:
        prompt.pendingTools = Math.max(0, prompt.pendingTools - 1);
        prompt.lastPendingTool = null;
        prompt.gotResponse = true;
        break;
      case EventKind.TurnEnd:
        prompt.gotResponse = true;
        prompt.turnEnded = true;
        break;
      default:
        break;
    }

    this.notifyPrompt(prompt);
  }

  private waitForPromptUpdate(
    prompt: PromptWaiter,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<"changed" | "timeout" | "abort" | "done"> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve("abort");
        return;
      }
      if (this.pumpDone) {
        resolve("done");
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: "changed" | "timeout" | "abort" | "done") => {
        if (settled) return;
        settled = true;
        prompt.waiters.delete(onChange);
        signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      const onChange = () => finish("changed");
      const onAbort = () => finish("abort");

      prompt.waiters.add(onChange);
      signal.addEventListener("abort", onAbort, { once: true });

      if (timeoutMs != null) {
        timer = setTimeout(() => finish("timeout"), timeoutMs);
      }

      if (this.pumpDone) {
        finish("done");
      }
    });
  }

  private async waitForPromptCompletion(
    prompt: PromptWaiter,
    signal: AbortSignal,
  ): Promise<"end_turn" | "cancelled"> {
    while (true) {
      if (signal.aborted) return "cancelled";
      if (this.stopped) return "cancelled";
      if (this.pumpDone) {
        if (this.pumpError) {
          this.logger.warn("prompt ending after pump shutdown", "sid", this.sessionId);
        }
        return "end_turn";
      }
      if (prompt.inputDeferred) {
        return "end_turn";
      }
      if (prompt.turnEnded && prompt.pendingTools <= 0) {
        return "end_turn";
      }

      const result = await this.waitForPromptUpdate(
        prompt,
        signal,
        prompt.matchedUserEcho ? IDLE_TIMEOUT_MS : undefined,
      );

      if (result === "abort") return "cancelled";
      if (result === "done") return "end_turn";
      if (result === "changed") {
        prompt.consecutiveIdles = 0;
        continue;
      }

      if (result === "timeout") {
        prompt.consecutiveIdles++;
        if (!prompt.matchedUserEcho) {
          continue;
        }
        if (prompt.inputDeferred) {
          return "end_turn";
        }
        if (prompt.turnEnded && prompt.pendingTools <= 0) {
          return "end_turn";
        }
        if (prompt.pendingTools > 0) {
          const handled = await this.pollNativePermission(prompt.lastPendingTool);
          if (handled === "handled" || handled === "consumed") {
            prompt.pendingTools = Math.max(0, prompt.pendingTools - 1);
            prompt.gotResponse = true;
            prompt.lastPendingTool = null;
            this.notifyPrompt(prompt);
          }
          continue;
        }
        // Idle fallback: if we received assistant output, no tools are
        // pending, and two consecutive idle periods passed with no new
        // events, treat this as turn completion even when the JSONL didn't
        // include an explicit TurnEnd event.
        if (prompt.gotResponse && prompt.consecutiveIdles >= 2) {
          return "end_turn";
        }
        continue;
      }
    }
  }

  private async pollNativePermission(
    pendingTool: PendingTool | null,
    intendedText: string | null = null,
  ): Promise<NativePermissionHandling> {
    let paneText: string;
    try {
      paneText = await this.wrapper.capturePane();
    } catch {
      return "none";
    }

    const prompt = parseNativePermissionPrompt(paneText);
    if (!prompt) {
      this.lastNativePermissionFingerprint = null;
      this.lastNativePermissionOutcome = "none";
      return "none";
    }

    const fingerprint = `${prompt.question}\n${prompt.options
      .map((option) => `${option.number}:${option.label}`)
      .join("\n")}`;
    if (this.lastNativePermissionFingerprint === fingerprint) {
      if (
        this.lastNativePermissionOutcome === "handled"
        || this.lastNativePermissionOutcome === "consumed"
      ) {
        return "pending_clear";
      }
      if (this.lastNativePermissionOutcome !== "deferred") {
        return this.lastNativePermissionOutcome;
      }
    }

    const decision = await this.resolvePermission({
      source: "native_prompt",
      sessionId: this.sessionId,
      toolCallId: pendingTool?.id ?? `native-perm-${Date.now()}`,
      title: pendingTool
        ? `${pendingTool.name}: ${prompt.question}`
        : prompt.question,
      kind: pendingTool ? mapToolKind(pendingTool.name) : "other",
      content: [
        ...(pendingTool
          ? (() => {
              const detail = formatToolDetail(
                pendingTool.name,
                pendingTool.input,
              );
              return detail ? [{ type: "text" as const, text: detail }] : [];
            })()
          : []),
        { type: "text", text: prompt.question },
      ],
      options: prompt.options.map((opt) => ({
        kind:
          opt.label.toLowerCase().startsWith("no") ||
          opt.label.toLowerCase().startsWith("reject")
            ? "reject_once"
            : "allow_once",
        optionId: opt.number,
        name: opt.label,
      })),
    });

    let outcome: NativePermissionHandling;
    if (decision.outcome === "deferred") {
      outcome = "deferred";
    } else if (decision.outcome === "cancelled") {
      await this.safeInterruptNativePermission();
      outcome = "handled";
    } else if (decision.outcome === "text") {
      await this.safeSendNativePermission(decision.text, false);
      outcome = decision.text === intendedText ? "consumed" : "handled";
    } else {
      const selected = prompt.options.find((option) => option.number === decision.optionId);
      const tolerateExit = selected ? isRejectingNativeOption(selected.label) : false;
      await this.safeSendNativePermission(decision.optionId, tolerateExit);
      outcome = decision.optionId === intendedText ? "consumed" : "handled";
    }

    this.lastNativePermissionFingerprint = fingerprint;
    this.lastNativePermissionOutcome = outcome;
    return outcome;
  }

  private async safeSendNativePermission(
    input: string,
    tolerateExit: boolean,
  ): Promise<void> {
    try {
      await this.wrapper.send(input);
    } catch (error) {
      if (tolerateExit && !this.wrapper.isProcessAlive()) {
        this.logger.debug("native permission send ignored after pane exit", "sid", this.sessionId);
        return;
      }
      throw error;
    }
  }

  private async safeInterruptNativePermission(): Promise<void> {
    try {
      await this.wrapper.interrupt();
    } catch (error) {
      if (!this.wrapper.isProcessAlive()) {
        this.logger.debug("native permission interrupt ignored after pane exit", "sid", this.sessionId);
        return;
      }
      throw error;
    }
  }

  /**
   * Poll the terminal until Claude enters INSERT or NORMAL mode.
   * Used after answering a blocking prompt (e.g. trust folder) to wait
   * for Claude to be ready to accept input.
   */
  private async waitForInsertMode(timeoutMs = 15_000): Promise<boolean> {
    const POLL_MS = 300;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.wrapper.isProcessAlive()) {
        return false;
      }
      try {
        const pane = await this.wrapper.capturePane();
        if (hasReadyModePrompt(pane)) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return false;
  }

  private async handleUserQuestion(ev: ClaudrabandEvent): Promise<boolean> {
    const parsed = parseAskUserQuestion(ev.toolInput);
    if (!parsed) {
      this.logger.warn(
        "AskUserQuestion parse failed",
        "sid",
        this.sessionId,
      );
      await this.wrapper.send("1");
      return false;
    }

    for (const question of parsed.questions) {
      const decision = await this.resolvePermission({
        source: "ask_user_question",
        sessionId: this.sessionId,
        toolCallId: ev.toolID,
        title: question.header || "Claude has a question",
        kind: "other",
        content: [{ type: "text", text: question.question }],
        options: buildAskUserQuestionOptions(question, this.allowTextResponses),
      });

      if (decision.outcome === "deferred") {
        // Leave the question pending so the caller can answer it later.
        return true;
      }

      if (decision.outcome === "cancelled") {
        await this.wrapper.interrupt();
        return false;
      }

      if (decision.outcome === "text") {
        await this.wrapper.send(decision.text);
        return false;
      }

      // outcome === "selected"
      if (decision.optionId === "0") {
        await this.wrapper.interrupt();
        return false;
      }

      await this.wrapper.send(decision.optionId);
    }
    return false;
  }

  private async resolvePermission(
    request: ClaudrabandPermissionRequest,
  ): Promise<ClaudrabandPermissionDecision> {
    if (!this.onPermissionRequest) {
      return { outcome: "cancelled" };
    }

    try {
      return await this.onPermissionRequest(request);
    } catch (err) {
      this.logger.error("permission handler failed", err);
      return { outcome: "cancelled" };
    }
  }
}

export const __test = {
  buildAskUserQuestionOptions,
  createSession(
    wrapper: SessionWrapper,
    options: {
      sessionId?: string;
      cwd?: string;
      backend?: ResolvedTerminalBackend;
      model?: string;
      permissionMode?: PermissionMode;
      allowTextResponses?: boolean;
      logger?: ClaudrabandLogger;
      onPermissionRequest?: ClaudrabandOptions["onPermissionRequest"];
      lifetime?: AbortController;
    } = {},
  ): ClaudrabandSession {
    return new ClaudrabandSessionImpl(
      wrapper,
      options.sessionId ?? "test-session",
      options.cwd ?? "/tmp",
      options.backend ?? "tmux",
      options.model ?? "sonnet",
      options.permissionMode ?? "default",
      options.allowTextResponses ?? false,
      options.logger ?? makeDefaultLogger(),
      options.onPermissionRequest,
      options.lifetime ?? new AbortController(),
    );
  },
};

function buildAskUserQuestionOptions(
  question: AskUserQuestionItem,
  allowTextResponses = false,
): ClaudrabandPermissionOption[] {
  return [
    ...question.options.map((opt, i) => ({
      kind: "allow_once" as const,
      optionId: String(i + 1),
      name: opt.label + (opt.description ? ` — ${opt.description}` : ""),
    })),
    ...(allowTextResponses
      ? [{
        kind: "allow_once" as const,
        optionId: String(question.options.length + 1),
        name: "Type a response",
        textInput: true,
      }]
      : []),
    {
      kind: "reject_once" as const,
      optionId: "0",
      name: "Cancel",
    },
  ];
}

function hasReadyModePrompt(paneText: string): boolean {
  // Strip ANSI/CSI escape sequences (xterm serialize output includes them)
  // and carriage returns before looking for the TUI mode indicator.
  const stripped = paneText
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "");
  const lines = stripped.split("\n");
  // Scan the trailing non-empty lines. Some TUI frames render trailing
  // border or padding lines after the status bar, so don't require the mode
  // indicator to be literally the last non-empty line.
  let scanned = 0;
  for (let index = lines.length - 1; index >= 0 && scanned < 5; index--) {
    const line = lines[index]?.trimEnd() ?? "";
    if (!line.trim()) continue;
    scanned++;
    if (READY_MODE_PROMPT_RE.test(line)) return true;
  }
  return false;
}

async function hasTranscriptTurnInProgress(jsonlPath: string): Promise<boolean> {
  let data: string;
  try {
    data = await readFile(jsonlPath, "utf-8");
  } catch {
    return false;
  }

  let inProgress = false;
  for (const line of data.split("\n")) {
    for (const event of parseLineEvents(line)) {
      switch (event.kind) {
        case EventKind.UserMessage:
        case EventKind.AssistantText:
        case EventKind.AssistantThinking:
        case EventKind.ToolCall:
        case EventKind.ToolResult:
        case EventKind.TurnStart:
          inProgress = true;
          break;
        case EventKind.TurnEnd:
          inProgress = false;
          break;
      }
    }
  }

  return inProgress;
}

async function discoverSessions(cwdFilter?: string): Promise<SessionSummary[]> {
  await reconcileLiveLocalSessions(cwdFilter);
  const live = (await refreshSessionRecords(await listSessionRecords()))
    .filter((record) => !cwdFilter || record.cwd === cwdFilter)
    .map(sessionRecordToSummary);
  const liveKeys = new Set(live.map((session) => `${session.sessionId}\t${session.cwd}`));
  const history = (await discoverHistoricalSessions(cwdFilter))
    .filter((session) => !liveKeys.has(`${session.sessionId}\t${session.cwd}`));

  return [...live, ...history].sort((left, right) =>
    Number(right.alive) - Number(left.alive) ||
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    left.sessionId.localeCompare(right.sessionId),
  );
}

async function inspectSession(
  sessionId: string,
  cwd?: string,
): Promise<SessionSummary | null> {
  await reconcileLiveLocalSessions(cwd);
  const record = await readSessionRecord(sessionId);
  if (record && (!cwd || record.cwd === cwd)) {
    const refreshed = await refreshSessionRecords([record]);
    if (refreshed[0]) {
      return sessionRecordToSummary(refreshed[0]);
    }
  }

  const history = await discoverHistoricalSessions(cwd);
  const matches = history.filter((session) => session.sessionId === sessionId);
  const match = matches[0] ?? null;
  if (!match) return null;
  if (match.owner.kind === "daemon") {
    return {
      ...match,
      source: "live",
    };
  }
  return match;
}

async function closeSessionByRecord(sessionId: string): Promise<boolean> {
  await reconcileLiveLocalSessions();
  const record = await readSessionRecord(sessionId);
  if (!record) return false;

  const [refreshed] = await refreshSessionRecords([record]);
  if (!refreshed?.lastKnownAlive) {
    return false;
  }

  let closed = false;
  if (refreshed.owner.kind === "daemon") {
    closed = await closeDaemonSession(refreshed.owner.serverUrl, refreshed.sessionId);
  } else if (refreshed.backend === "tmux") {
    closed = await createTerminalBackendDriver({
      backend: "tmux",
      tmuxSessionName: SHARED_TMUX_SESSION,
    }).closeLiveSession(refreshed.sessionId);
  } else if (isPidAlive(refreshed.owner.pid)) {
    try {
      process.kill(refreshed.owner.pid!);
      closed = true;
    } catch {
      closed = false;
    }
  }

  if (closed) {
    await deleteSessionRecord(sessionId);
  }

  return closed;
}

async function reconcileLiveLocalSessions(cwdFilter?: string): Promise<void> {
  const discovered = await discoverLegacyLiveSessions(
    createTerminalBackendDriver({
      backend: "tmux",
      tmuxSessionName: SHARED_TMUX_SESSION,
    }),
    cwdFilter,
  );
  for (const session of discovered) {
    const existing = await readSessionRecord(session.sessionId);
    const known = await readKnownSessionRecord(session.sessionId);
    const transcriptPath = sessionPath(session.cwd, session.sessionId);
    const title = existing?.title ?? known?.title ?? session.title;
    const createdAt = existing?.createdAt ?? known?.createdAt ?? session.createdAt;
    const updatedAt = session.updatedAt ?? existing?.updatedAt ?? known?.updatedAt ?? session.createdAt;
    // Preserve a daemon owner if one is already recorded AND that daemon
    // is still alive. Otherwise this reconciliation pass (which only
    // inspects tmux panes) would silently demote daemon-owned sessions to
    // local on every call, and also wrongly keep a daemon owner around
    // after the daemon has died.
    const candidateDaemonOwner =
      existing?.owner.kind === "daemon"
        ? existing.owner
        : known?.owner?.kind === "daemon"
          ? known.owner
          : null;
    const daemonOwner =
      candidateDaemonOwner && isPidAlive(candidateDaemonOwner.serverPid)
        ? candidateDaemonOwner
        : null;
    const owner: SessionOwnerRecord = daemonOwner ?? {
      kind: "local",
      pid: session.owner.kind === "local" ? session.owner.pid : undefined,
    };

    await writeKnownSessionRecord({
      version: 1,
      sessionId: session.sessionId,
      cwd: session.cwd,
      backend: session.backend,
      title,
      createdAt,
      updatedAt,
      transcriptPath,
      owner,
    });

    await writeSessionRecord({
      version: 1,
      sessionId: session.sessionId,
      cwd: session.cwd,
      backend: session.backend,
      title,
      createdAt,
      updatedAt,
      lastKnownAlive: true,
      reattachable: session.reattachable,
      transcriptPath,
      owner,
    });
  }
}

async function discoverHistoricalSessions(cwdFilter?: string): Promise<SessionSummary[]> {
  const records = (await listKnownSessionRecords())
    .filter((record) => !cwdFilter || record.cwd === cwdFilter);
  const results: SessionSummary[] = [];

  for (const record of records) {
    const transcriptPath = record.transcriptPath ?? sessionPath(record.cwd, record.sessionId);
    try {
      const fileStat = await stat(transcriptPath);
      if (fileStat.size < 100) continue;
      results.push({
        sessionId: record.sessionId,
        cwd: record.cwd,
        title: record.title ?? await extractSessionTitle(transcriptPath) ?? undefined,
        createdAt: record.createdAt || fileStat.birthtime.toISOString(),
        updatedAt: fileStat.mtime.toISOString(),
        backend: record.backend,
        source: "history",
        alive: false,
        reattachable: false,
        owner: record.owner ?? { kind: "local" },
      });
    } catch {
      continue;
    }
  }

  return results;
}

async function discoverLegacyLiveSessions(
  backendDriver: TerminalBackendDriver,
  cwdFilter?: string,
): Promise<SessionSummary[]> {
  try {
    const windows = await backendDriver.listLiveSessions();
    const results: SessionSummary[] = [];

    for (const window of windows) {
      if (!isSessionId(window.sessionId)) continue;
      if (!window.cwd) continue;
      if (cwdFilter && window.cwd !== cwdFilter) continue;
      results.push({
        sessionId: window.sessionId,
        cwd: window.cwd,
        createdAt: window.updatedAt ?? new Date().toISOString(),
        updatedAt: window.updatedAt,
        backend: backendDriver.backend,
        source: "live",
        alive: true,
        reattachable: backendDriver.supportsLiveReconnect(),
        owner: {
          kind: "local",
          pid: window.pid,
        },
      });
    }

    return results;
  } catch {
    return [];
  }
}

async function refreshSessionRecords(records: SessionRecord[]): Promise<SessionRecord[]> {
  const tmuxDriver = createTerminalBackendDriver({
    backend: "tmux",
    tmuxSessionName: SHARED_TMUX_SESSION,
  });
  const tmuxWindows = await tmuxDriver.listLiveSessions().catch(() => []);
  const tmuxById = new Map(tmuxWindows.map((window) => [window.sessionId, window]));
  const daemonByUrl = new Map<string, Map<string, boolean> | null>();
  const refreshed: SessionRecord[] = [];

  for (const record of records) {
    const metadata = await readRecordMetadata(record);
    let next: SessionRecord = {
      ...record,
      transcriptPath: metadata.transcriptPath,
      title: metadata.title,
      updatedAt: metadata.updatedAt ?? record.updatedAt,
    };

    if (record.owner.kind === "daemon") {
      const serverUrl = normalizeServerUrl(record.owner.serverUrl);
      if (!daemonByUrl.has(serverUrl)) {
        daemonByUrl.set(
          serverUrl,
          isPidAlive(record.owner.serverPid)
            ? await fetchDaemonSessionStates(serverUrl)
            : null,
        );
      }
      const daemonSessions = daemonByUrl.get(serverUrl);
      const alive = daemonSessions?.get(record.sessionId) ?? false;
      next = {
        ...next,
        owner: {
          ...record.owner,
          serverUrl,
        },
        lastKnownAlive: alive,
        reattachable: alive,
      };
    } else if (record.backend === "tmux") {
      const liveWindow = tmuxById.get(record.sessionId);
      next = {
        ...next,
        owner: {
          kind: "local",
          pid: liveWindow?.pid ?? record.owner.pid,
        },
        lastKnownAlive: liveWindow !== undefined,
        reattachable: liveWindow !== undefined,
      };
    } else {
      const alive = isPidAlive(record.owner.pid);
      next = {
        ...next,
        lastKnownAlive: alive,
        reattachable: false,
      };
    }

    if (!next.lastKnownAlive) {
      await deleteSessionRecord(record.sessionId);
      continue;
    }
    if (!sessionRecordsEqual(record, next)) {
      await writeSessionRecord(next);
    }
    refreshed.push(next);
  }

  return refreshed;
}

async function readRecordMetadata(record: SessionRecord): Promise<{
  transcriptPath: string;
  title?: string;
  updatedAt?: string;
}> {
  const transcriptPath = record.transcriptPath ?? sessionPath(record.cwd, record.sessionId);
  try {
    const transcriptStat = await stat(transcriptPath);
    return {
      transcriptPath,
      title: record.title ?? await extractSessionTitle(transcriptPath) ?? undefined,
      updatedAt: transcriptStat.mtime.toISOString(),
    };
  } catch {
    return {
      transcriptPath,
      title: record.title,
      updatedAt: record.updatedAt,
    };
  }
}

function sessionRecordToSummary(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    backend: record.backend,
    source: "live",
    alive: record.lastKnownAlive,
    reattachable: record.reattachable,
    owner: record.owner,
  };
}

function sessionRecordsEqual(left: SessionRecord, right: SessionRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

async function fetchDaemonSessionStates(serverUrl: string): Promise<Map<string, boolean> | null> {
  try {
    const result = await daemonRequest(serverUrl, "GET", "/sessions") as {
      sessions?: Array<{ sessionId: string; alive: boolean }>;
    };
    const sessions = new Map<string, boolean>();
    for (const session of result.sessions ?? []) {
      sessions.set(session.sessionId, session.alive);
    }
    return sessions;
  } catch {
    return null;
  }
}

async function closeDaemonSession(serverUrl: string, sessionId: string): Promise<boolean> {
  try {
    await daemonRequest(serverUrl, "DELETE", `/sessions/${sessionId}`);
    return true;
  } catch {
    return false;
  }
}

async function daemonRequest(
  serverUrl: string,
  method: "GET" | "DELETE",
  path: string,
): Promise<unknown> {
  const url = new URL(path, normalizeServerUrl(serverUrl));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(text || `request failed with status ${res.statusCode}`));
            return;
          }
          if (!text) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function extractSessionTitle(filePath: string): Promise<string | null> {
  try {
    const buf = Buffer.alloc(4096);
    const fh = await open(filePath, "r");
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    await fh.close();

    for (const line of buf.toString("utf-8", 0, bytesRead).split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          message?: { content?: string | Array<{ type?: string; text?: string }> };
        };
        if (obj.type !== "user" || !obj.message?.content) continue;
        const content =
          typeof obj.message.content === "string"
            ? obj.message.content
            : obj.message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join(" ");
        return content.length > 80 ? `${content.slice(0, 77)}...` : content;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function mapToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "Read":
    case "ReadFile":
    case "read_file":
      return "read";
    case "Write":
    case "WriteFile":
    case "write_to_file":
    case "Edit":
    case "EditFile":
    case "str_replace_editor":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "bash":
    case "execute_command":
      return "execute";
    case "Grep":
    case "Glob":
    case "Search":
    case "grep":
    case "search":
    case "find_file":
    case "list_files":
      return "search";
    case "WebFetch":
    case "WebSearch":
    case "web_fetch":
    case "fetch":
      return "fetch";
    case "Think":
    case "think":
      return "think";
    default:
      return "other";
  }
}

function formatToolDetail(toolName: string, toolInput: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(toolInput) as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (toolName) {
    case "Write": {
      const filePath = String(parsed.file_path ?? parsed.path ?? "");
      const content = String(parsed.content ?? "");
      return `**${filePath}**\n\`\`\`\n${content}\n\`\`\``;
    }
    case "Edit": {
      const filePath = String(parsed.file_path ?? parsed.path ?? "");
      const oldStr = String(parsed.old_string ?? "");
      const newStr = String(parsed.new_string ?? "");
      return `**${filePath}**\n\`\`\`diff\n- ${oldStr.split("\n").join("\n- ")}\n+ ${newStr.split("\n").join("\n+ ")}\n\`\`\``;
    }
    case "Bash":
      return `\`\`\`bash\n${String(parsed.command ?? "")}\n\`\`\``;
    default:
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  }
}

function parseAskUserQuestion(rawInput: string): AskUserQuestion | null {
  try {
    const parsed = JSON.parse(rawInput) as AskUserQuestion;
    if (!parsed.questions || parsed.questions.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
