import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PermissionOption,
  SessionUpdate,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionMode,
  SessionModeState,
  ToolCallContent,
  ContentBlock,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClaudeWrapper } from "../clients/claude";
import type { Event } from "../wrap/event";
import { EventKind } from "../wrap/event";
import { mapToolKind, parseAskUserQuestion, extractLocations } from "./toolmap";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PANE_WIDTH = 120;
const DEFAULT_PANE_HEIGHT = 40;
const IDLE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Config option / mode constants
// ---------------------------------------------------------------------------

const MODEL_OPTIONS: SessionConfigSelectOption[] = [
  { value: "haiku", name: "Haiku", description: "Fast and lightweight" },
  {
    value: "sonnet",
    name: "Sonnet",
    description: "Balanced speed and intelligence",
  },
  { value: "opus", name: "Opus", description: "Most capable" },
];

const PERMISSION_MODES: { id: string; name: string; description: string }[] = [
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
];

function buildConfigOptions(
  model: string,
  permissionMode: string,
): SessionConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: MODEL_OPTIONS,
    } as SessionConfigOption,
    {
      type: "select",
      id: "permission_mode",
      name: "Permission Mode",
      category: "mode",
      currentValue: permissionMode,
      options: PERMISSION_MODES.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    } as SessionConfigOption,
  ];
}

function buildModes(currentModeId: string): SessionModeState {
  const availableModes: SessionMode[] = PERMISSION_MODES.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
  }));
  return { availableModes, currentModeId };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

function makeDefaultLogger(): Logger {
  return {
    info: (msg, ...args) => console.log(msg, ...args),
    debug: (msg, ...args) => console.debug(msg, ...args),
    warn: (msg, ...args) => console.warn(msg, ...args),
    error: (msg, ...args) => console.error(msg, ...args),
  };
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  wrapper: ClaudeWrapper;
  abortController: AbortController | null;
  cwd: string;
  model: string;
  permissionMode: string;
  claudeSessionId: string;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class Bridge implements Agent {
  private conn!: AgentSideConnection;
  private model: string;
  private sessions: Map<string, Session> = new Map();
  private log: Logger;

  constructor(model: string) {
    this.model = model || "sonnet";
    this.log = makeDefaultLogger();
  }

  setConnection(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  setLogger(log: Logger): void {
    this.log = log;
  }

  shutdown(): void {
    const n = this.sessions.size;
    for (const [sid, s] of this.sessions) {
      this.log.info("stopping session", sid);
      s.wrapper.stop().catch(() => {});
    }
    this.sessions.clear();
    this.log.info("shutdown complete", "sessions_stopped", n);
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    let clientName = "";
    if (params.clientInfo) {
      clientName = params.clientInfo.name;
      if (params.clientInfo.version) {
        clientName += " " + params.clientInfo.version;
      }
    }
    this.log.info(
      "client connected",
      "client",
      clientName,
      "protocol_version",
      params.protocolVersion,
    );

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: {
        name: "allagent",
        title: "allagent (Claude Code)",
        version: "0.1.0",
      },
    };
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sid = randomID();
    const tmuxName = "allagent-" + sid.slice(0, 12);

    const { ClaudeWrapper } = await import("../clients/claude");
    const permissionMode = "default";
    const w = new ClaudeWrapper({
      model: this.model,
      permissionMode,
      workingDir: params.cwd,
      tmuxSession: tmuxName,
      paneWidth: DEFAULT_PANE_WIDTH,
      paneHeight: DEFAULT_PANE_HEIGHT,
    });

    await w.start(this.conn.signal);
    this.sessions.set(sid, {
      id: sid,
      wrapper: w,
      abortController: null,
      cwd: params.cwd,
      model: this.model,
      permissionMode,
      claudeSessionId: w.claudeSessionId,
    });

    this.log.info(
      "session created",
      "sid",
      sid,
      "cwd",
      params.cwd,
      "model",
      this.model,
    );
    return {
      sessionId: sid,
      configOptions: buildConfigOptions(this.model, permissionMode),
      modes: buildModes(permissionMode),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const claudeSessionId = params.sessionId;
    const sid = randomID();
    const tmuxName = "allagent-" + sid.slice(0, 12);

    const { ClaudeWrapper } = await import("../clients/claude");
    const permissionMode = "default";
    const w = new ClaudeWrapper({
      model: this.model,
      permissionMode,
      workingDir: params.cwd,
      tmuxSession: tmuxName,
      paneWidth: DEFAULT_PANE_WIDTH,
      paneHeight: DEFAULT_PANE_HEIGHT,
    });

    // Replay existing JSONL events as session updates before starting.
    await this.replayHistory(sid, params.cwd, claudeSessionId);

    await w.startResume(claudeSessionId, this.conn.signal);
    this.sessions.set(sid, {
      id: sid,
      wrapper: w,
      abortController: null,
      cwd: params.cwd,
      model: this.model,
      permissionMode,
      claudeSessionId,
    });

    this.log.info(
      "session loaded",
      "sid",
      sid,
      "claudeSessionId",
      claudeSessionId,
      "cwd",
      params.cwd,
    );
    return {
      configOptions: buildConfigOptions(this.model, permissionMode),
      modes: buildModes(permissionMode),
    };
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const sessions = await discoverSessions(params.cwd ?? undefined);
    this.log.info(
      "session list",
      "count",
      sessions.length,
      "cwd_filter",
      params.cwd ?? "none",
    );
    return { sessions };
  }

  // -------------------------------------------------------------------------
  // Prompt / Cancel
  // -------------------------------------------------------------------------

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sid = params.sessionId;
    const s = this.sessions.get(sid);
    if (!s) {
      throw new Error(`session ${sid} not found`);
    }

    if (s.abortController) {
      s.abortController.abort();
    }
    const ac = new AbortController();
    s.abortController = ac;

    const text = extractPromptText(params.prompt);
    if (!text) {
      ac.abort();
      return { stopReason: "end_turn" };
    }

    this.log.info("prompt received", "sid", sid, "length", text.length);

    await s.wrapper.send(text);

    const reason = await this.drainEvents(sid, s.wrapper, ac.signal);

    s.abortController = null;

    this.log.info("prompt completed", "sid", sid, "stop_reason", reason);
    return { stopReason: reason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sid = params.sessionId;
    this.log.info("cancel requested", "sid", sid);
    const s = this.sessions.get(sid);
    if (!s) return;
    if (s.abortController) {
      s.abortController.abort();
    }
    await s.wrapper.interrupt();
  }

  // -------------------------------------------------------------------------
  // Session modes
  // -------------------------------------------------------------------------

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const sid = params.sessionId;
    const s = this.sessions.get(sid);
    if (!s) throw new Error(`session ${sid} not found`);

    const modeId = params.modeId;
    if (!PERMISSION_MODES.some((m) => m.id === modeId)) {
      throw new Error(`unknown mode: ${modeId}`);
    }

    s.permissionMode = modeId;
    await this.restartWithMode(s, modeId);
    this.log.info("mode changed", "sid", sid, "mode", modeId);

    // Notify client of mode change.
    this.conn
      .sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: modeId,
        } as SessionUpdate,
      })
      .catch((err: unknown) => {
        this.log.error("failed to send mode update", "err", err);
      });

    return {};
  }

  /**
   * Restart Claude Code with a new permission mode. Kills the current tmux
   * session and re-spawns with --resume and the updated --permission-mode flag.
   */
  private async restartWithMode(s: Session, modeId: string): Promise<void> {
    s.wrapper.setPermissionMode(modeId);
    try {
      await s.wrapper.restart();
    } catch (err) {
      this.log.error("restart failed", "sid", s.id, "mode", modeId, "err", err);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Session config options
  // -------------------------------------------------------------------------

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const sid = params.sessionId;
    const s = this.sessions.get(sid);
    if (!s) throw new Error(`session ${sid} not found`);

    const value = String(params.value);

    switch (params.configId) {
      case "model": {
        if (!MODEL_OPTIONS.some((m) => m.value === value)) {
          throw new Error(`unknown model: ${value}`);
        }
        s.model = value;
        await s.wrapper.send(`/model ${value}`);
        this.log.info("model changed", "sid", sid, "model", value);
        break;
      }
      case "permission_mode": {
        if (!PERMISSION_MODES.some((m) => m.id === value)) {
          throw new Error(`unknown permission mode: ${value}`);
        }
        s.permissionMode = value;
        await this.restartWithMode(s, value);
        this.log.info("permission mode changed", "sid", sid, "mode", value);

        // Also emit a mode update since modes mirror permission_mode.
        this.conn
          .sessionUpdate({
            sessionId: sid,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: value,
            } as SessionUpdate,
          })
          .catch((err: unknown) => {
            this.log.error("failed to send mode update", "err", err);
          });
        break;
      }
      default:
        throw new Error(`unknown config option: ${params.configId}`);
    }

    return {
      configOptions: buildConfigOptions(s.model, s.permissionMode),
    };
  }

  // -------------------------------------------------------------------------
  // History replay (for loadSession)
  // -------------------------------------------------------------------------

  private async replayHistory(
    sid: string,
    cwd: string,
    claudeSessionId: string,
  ): Promise<void> {
    const home = homedir();
    const escaped = cwd.replace(/\//g, "-");
    const jsonlPath = join(
      home,
      ".claude",
      "projects",
      escaped,
      `${claudeSessionId}.jsonl`,
    );

    let data: string;
    try {
      data = await readFile(jsonlPath, "utf-8");
    } catch {
      this.log.warn("no JSONL file to replay", "path", jsonlPath);
      return;
    }

    const { parseLineEvents } = await import("../clients/claude");

    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      const events = parseLineEvents(line);
      for (const ev of events) {
        this.sendEvent(sid, ev, { pendingTools: 0, gotResponse: false });
      }
    }

    this.log.info(
      "history replayed",
      "sid",
      sid,
      "claudeSessionId",
      claudeSessionId,
    );
  }

  // -------------------------------------------------------------------------
  // Event draining
  // -------------------------------------------------------------------------

  private async drainEvents(
    sid: string,
    w: ClaudeWrapper,
    signal: AbortSignal,
  ): Promise<"end_turn" | "cancelled"> {
    let pendingTools = 0;
    let gotResponse = false;

    const iter = w.events();

    // Pull the next event from the async generator as a promise we can race.
    let nextEvent: Promise<IteratorResult<Event>> = iter.next();

    try {
      while (true) {
        if (signal.aborted) return "cancelled";

        const idle = new Promise<"idle">((resolve) =>
          setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS),
        );

        const abort = new Promise<"abort">((resolve) => {
          if (signal.aborted) {
            resolve("abort");
            return;
          }
          signal.addEventListener("abort", () => resolve("abort"), {
            once: true,
          });
        });

        const result = await Promise.race([nextEvent, idle, abort]);

        if (result === "abort") return "cancelled";

        if (result === "idle") {
          if (gotResponse && pendingTools <= 0) {
            this.log.debug("idle timeout, ending turn", "sid", sid);
            return "end_turn";
          }
          // When tools are pending and we're idle, check if Claude Code is
          // showing a native permission prompt in the terminal.
          if (pendingTools > 0) {
            const handled = await this.pollNativePermission(sid, w);
            if (handled) {
              this.log.info("native permission handled", "sid", sid);
            }
          }
          this.log.debug(
            "idle timeout, still waiting",
            "sid",
            sid,
            "pending_tools",
            pendingTools,
            "got_response",
            gotResponse,
          );
          continue;
        }

        // result is an IteratorResult<Event>
        const iterResult = result as IteratorResult<Event>;
        if (iterResult.done) return "end_turn";

        const ev = iterResult.value;
        this.log.debug(
          "event received",
          "sid",
          sid,
          "kind",
          ev.kind,
          "tool",
          ev.toolName,
          "text_len",
          ev.text.length,
        );

        this.sendEvent(sid, ev, {
          get pendingTools() {
            return pendingTools;
          },
          set pendingTools(n: number) {
            pendingTools = n;
          },
          get gotResponse() {
            return gotResponse;
          },
          set gotResponse(v: boolean) {
            gotResponse = v;
          },
        });

        if (
          ev.kind === EventKind.ToolCall &&
          ev.toolName === "AskUserQuestion"
        ) {
          await this.handleUserQuestion(sid, ev, w);
        }

        // Queue next pull immediately so it's ready when we loop back to race.
        nextEvent = iter.next();
      }
    } finally {
      // Do NOT call iter.return() here — the tailer generator is shared across
      // prompt calls. Closing it would make subsequent drainEvents get {done: true}
      // immediately.
    }
  }

  // -------------------------------------------------------------------------
  // Event translation
  // -------------------------------------------------------------------------

  private sendEvent(
    sid: string,
    ev: Event,
    state: { pendingTools: number; gotResponse: boolean },
  ): void {
    let update: SessionUpdate | null = null;

    switch (ev.kind) {
      case EventKind.AssistantText: {
        state.gotResponse = true;
        update = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: ev.text },
        };
        break;
      }

      case EventKind.AssistantThinking: {
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: ev.text },
        };
        break;
      }

      case EventKind.ToolCall: {
        state.pendingTools++;
        this.log.info(
          "tool call",
          "tool",
          ev.toolName,
          "id",
          ev.toolID,
          "pending",
          state.pendingTools,
        );

        const kind = mapToolKind(ev.toolName);
        const locs = extractLocations(ev.toolInput);
        let rawInput: Record<string, unknown> | undefined;
        try {
          rawInput = JSON.parse(ev.toolInput);
        } catch {
          // leave undefined
        }

        const toolCallObj: Record<string, unknown> = {
          sessionUpdate: "tool_call",
          toolCallId: ev.toolID,
          title: ev.toolName,
          kind,
          status: "pending",
        };

        if (rawInput) {
          toolCallObj.rawInput = rawInput;
        }
        if (locs) {
          toolCallObj.locations = locs;
        }

        update = toolCallObj as unknown as SessionUpdate;
        break;
      }

      case EventKind.ToolResult: {
        state.pendingTools = Math.max(0, state.pendingTools - 1);
        this.log.info(
          "tool result",
          "id",
          ev.toolID,
          "pending",
          state.pendingTools,
        );

        const content: ToolCallContent[] = [
          {
            type: "content",
            content: { type: "text", text: ev.text },
          } as ToolCallContent,
        ];

        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: ev.toolID,
          status: "completed",
          content,
        } as unknown as SessionUpdate;
        break;
      }

      case EventKind.Error: {
        update = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Error: " + ev.text },
        };
        break;
      }

      case EventKind.System: {
        if (!ev.text) return;
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: ev.text },
        };
        break;
      }

      default:
        return;
    }

    if (!update) return;

    this.conn
      .sessionUpdate({ sessionId: sid, update })
      .catch((err: unknown) => {
        this.log.error(
          "failed to send session update",
          "err",
          err,
          "kind",
          ev.kind,
        );
      });
  }

  // -------------------------------------------------------------------------
  // Native permission prompt -> ACP RequestPermission
  // -------------------------------------------------------------------------

  /**
   * Capture the Claude Code tmux pane and check for a native permission
   * prompt (e.g. "Do you want to create fib.py?"). If found, forward it
   * to the ACP client via requestPermission and send the user's choice
   * back to Claude Code.
   */
  private async pollNativePermission(
    sid: string,
    w: ClaudeWrapper,
  ): Promise<boolean> {
    let paneText: string;
    try {
      paneText = await w.capturePane();
    } catch {
      return false;
    }

    const prompt = parseNativePermissionPrompt(paneText);
    if (!prompt) return false;

    this.log.info(
      "native permission prompt detected",
      "sid",
      sid,
      "question",
      prompt.question,
    );

    const opts: PermissionOption[] = prompt.options.map((opt) => ({
      kind:
        opt.label.toLowerCase().startsWith("no") ||
        opt.label.toLowerCase().startsWith("reject")
          ? ("reject_once" as const)
          : ("allow_once" as const),
      optionId: opt.number,
      name: opt.label,
    }));

    const content: ToolCallContent[] = [
      {
        type: "content",
        content: { type: "text", text: prompt.question },
      } as ToolCallContent,
    ];

    const resp = await this.conn.requestPermission({
      sessionId: sid,
      toolCall: {
        toolCallId: `native-perm-${Date.now()}`,
        title: prompt.question,
        kind: "other",
        status: "pending",
        content,
      },
      options: opts,
    });

    if (resp.outcome.outcome === "cancelled") {
      this.log.info("user cancelled native permission", "sid", sid);
      await w.interrupt();
      return true;
    }

    if (resp.outcome.outcome === "selected") {
      const id = resp.outcome.optionId;
      this.log.info(
        "user selected native permission option",
        "sid",
        sid,
        "optionId",
        id,
      );
      // Send the option number as a keypress to Claude Code's terminal
      await w.send(id);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // AskUserQuestion -> ACP RequestPermission
  // -------------------------------------------------------------------------

  private async handleUserQuestion(
    sid: string,
    ev: Event,
    w: ClaudeWrapper,
  ): Promise<void> {
    const parsed = parseAskUserQuestion(ev.toolInput);
    if (!parsed) {
      this.log.warn(
        "AskUserQuestion: could not parse input, sending default answer",
        "sid",
        sid,
      );
      await w.send("1");
      return;
    }

    for (const q of parsed.questions) {
      const header = q.header || "Claude has a question";

      const opts: PermissionOption[] = q.options.map((opt, i) => ({
        kind: "allow_once" as const,
        optionId: String(i + 1),
        name: opt.label + (opt.description ? " — " + opt.description : ""),
      }));
      opts.push({
        kind: "reject_once",
        optionId: "0",
        name: "Cancel",
      });

      this.log.debug(
        "permission options",
        "sid",
        sid,
        ...opts.flatMap((o) => [o.optionId, o.name, o.kind]),
      );

      const content: ToolCallContent[] = [
        {
          type: "content",
          content: { type: "text", text: q.question },
        } as ToolCallContent,
      ];

      const resp = await this.conn.requestPermission({
        sessionId: sid,
        toolCall: {
          toolCallId: ev.toolID,
          title: header,
          kind: "other",
          status: "pending",
          content,
        },
        options: opts,
      });

      if (resp.outcome.outcome === "cancelled") {
        this.log.info("user cancelled question", "sid", sid, "header", header);
        await w.interrupt();
        return;
      }

      if (resp.outcome.outcome === "selected") {
        const id = resp.outcome.optionId;
        if (id === "0") {
          this.log.info("user selected cancel", "sid", sid, "header", header);
          await w.interrupt();
          return;
        }
        this.log.info(
          "user selected option",
          "sid",
          sid,
          "header",
          header,
          "optionId",
          id,
        );
        await w.send(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session discovery (for listSessions)
// ---------------------------------------------------------------------------

interface ClaudeSessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  name?: string;
}

async function discoverSessions(
  cwdFilter?: string,
): Promise<ListSessionsResponse["sessions"]> {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const results: ListSessionsResponse["sessions"] = [];

  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(sessionsDir, f), "utf-8");
      const meta: ClaudeSessionMeta = JSON.parse(raw);
      if (!meta.sessionId || !meta.cwd) continue;
      if (cwdFilter && meta.cwd !== cwdFilter) continue;

      results.push({
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        title: meta.name ?? undefined,
        updatedAt: meta.startedAt
          ? new Date(meta.startedAt).toISOString()
          : undefined,
      });
    } catch {
      continue;
    }
  }

  // Sort by most recent first.
  results.sort((a, b) => {
    const ta = a.updatedAt ?? "";
    const tb = b.updatedAt ?? "";
    return tb.localeCompare(ta);
  });

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPromptText(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return "";
  let text = "";
  for (const b of blocks) {
    if ("text" in b && typeof b.text === "string") {
      text += b.text;
    }
  }
  return text;
}

function randomID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return (
    "sess_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

// ---------------------------------------------------------------------------
// Native permission prompt detection
// ---------------------------------------------------------------------------

interface NativePermissionPrompt {
  question: string;
  options: { number: string; label: string }[];
}

/**
 * Parse Claude Code's native permission dialog from captured tmux pane text.
 *
 * The format looks like:
 *   Do you want to create fib.py?
 *   ❯ 1. Yes
 *     2. Yes, allow all edits during this session (shift+tab)
 *     3. No
 */
function parseNativePermissionPrompt(
  paneText: string,
): NativePermissionPrompt | null {
  // Look for "Do you want to ..." question line
  const questionMatch = paneText.match(/(?:^|\n)\s*(Do you want to [^\n]+\?)/);
  if (!questionMatch) return null;

  // Look for numbered options after the question
  const afterQuestion = paneText.slice(
    paneText.indexOf(questionMatch[1]) + questionMatch[1].length,
  );
  const optionRegex = /(?:❯\s*)?(\d+)\.\s+(.+)/g;
  const options: { number: string; label: string }[] = [];

  let match;
  while ((match = optionRegex.exec(afterQuestion)) !== null) {
    options.push({ number: match[1], label: match[2].trim() });
  }

  if (options.length === 0) return null;

  return { question: questionMatch[1], options };
}
