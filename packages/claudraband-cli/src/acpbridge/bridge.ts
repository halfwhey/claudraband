import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  createClaudraband,
  EventKind,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  type Claudraband,
  type ClaudrabandEvent,
  type ClaudrabandLogger,
  type ClaudrabandPermissionDecision,
  type ClaudrabandPermissionRequest,
  type ClaudrabandSession,
  type PermissionMode,
  type TerminalBackend,
  type TurnDetectionMode,
} from "claudraband-core";
import { extractLocations, mapToolKind } from "./toolmap";

function buildConfigOptions(
  model: string,
  permissionMode: PermissionMode,
): SessionConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: MODEL_OPTIONS as unknown as SessionConfigSelectOption[],
    } as SessionConfigOption,
    {
      type: "select",
      id: "permission_mode",
      name: "Permission Mode",
      category: "mode",
      currentValue: permissionMode,
      options: PERMISSION_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    } as SessionConfigOption,
  ];
}

function buildModes(currentModeId: PermissionMode): SessionModeState {
  const availableModes: SessionMode[] = PERMISSION_MODES.map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description,
  }));
  return { availableModes, currentModeId };
}

interface BridgeSession {
  session: ClaudrabandSession;
}

function makeDefaultLogger(): ClaudrabandLogger {
  return {
    info: (msg, ...args) => console.log(msg, ...args),
    debug: (msg, ...args) => console.debug(msg, ...args),
    warn: (msg, ...args) => console.warn(msg, ...args),
    error: (msg, ...args) => console.error(msg, ...args),
  };
}

export class Bridge implements Agent {
  private conn!: AgentSideConnection;
  private runtime: Claudraband;
  private defaultClaudeArgs: string[];
  private defaultModel: string;
  private defaultPermissionMode: PermissionMode;
  private defaultTerminalBackend: TerminalBackend;
  private defaultTurnDetection: TurnDetectionMode;
  private sessions = new Map<string, BridgeSession>();
  private log: ClaudrabandLogger;

  constructor(config: {
    claudeArgs: string[];
    model: string;
    permissionMode: PermissionMode;
    terminalBackend: TerminalBackend;
    turnDetection: TurnDetectionMode;
  }) {
    this.defaultClaudeArgs = config.claudeArgs;
    this.defaultModel = config.model || "sonnet";
    this.defaultPermissionMode = config.permissionMode;
    this.defaultTerminalBackend = config.terminalBackend;
    this.defaultTurnDetection = config.turnDetection;
    this.log = makeDefaultLogger();
    this.runtime = createClaudraband({
      claudeArgs: this.defaultClaudeArgs,
      model: this.defaultModel,
      permissionMode: this.defaultPermissionMode,
      terminalBackend: this.defaultTerminalBackend,
      turnDetection: this.defaultTurnDetection,
    });
  }

  setConnection(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  setLogger(log: ClaudrabandLogger): void {
    this.log = log;
    this.runtime = createClaudraband({
      claudeArgs: this.defaultClaudeArgs,
      model: this.defaultModel,
      permissionMode: this.defaultPermissionMode,
      terminalBackend: this.defaultTerminalBackend,
      turnDetection: this.defaultTurnDetection,
      logger: log,
    });
  }

  shutdown(): void {
    for (const [sid, entry] of this.sessions) {
      this.log.info("detaching session", sid);
      entry.session.detach().catch(() => {});
    }
    this.sessions.clear();
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const clientName = params.clientInfo
      ? `${params.clientInfo.name}${params.clientInfo.version ? ` ${params.clientInfo.version}` : ""}`
      : "";
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
        name: "claudraband",
        title: "claudraband (Claude Code)",
        version: "0.1.0",
      },
    };
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const session = await this.runtime.openSession({
      cwd: params.cwd,
      claudeArgs: this.defaultClaudeArgs,
      model: this.defaultModel,
      permissionMode: this.defaultPermissionMode,
      logger: this.log,
      onPermissionRequest: (request: ClaudrabandPermissionRequest) =>
        this.handlePermissionRequest(request),
    });
    this.sessions.set(session.sessionId, { session });
    this.attachSession(session);

    return {
      sessionId: session.sessionId,
      configOptions: buildConfigOptions(session.model, session.permissionMode),
      modes: buildModes(session.permissionMode),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const history = await this.runtime.replaySession(params.sessionId, params.cwd);
    for (const event of history) {
      this.sendEvent(params.sessionId, event);
    }

    const session = await this.runtime.openSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      claudeArgs: this.defaultClaudeArgs,
      model: this.defaultModel,
      permissionMode: this.defaultPermissionMode,
      logger: this.log,
      onPermissionRequest: (request: ClaudrabandPermissionRequest) =>
        this.handlePermissionRequest(request),
    });
    this.sessions.set(params.sessionId, { session });
    this.attachSession(session);

    return {
      configOptions: buildConfigOptions(session.model, session.permissionMode),
      modes: buildModes(session.permissionMode),
    };
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const sessions = (await this.runtime.listSessions(params.cwd ?? undefined))
      .filter((session) => session.source === "live" && session.alive);
    return { sessions };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    return session.prompt(extractPromptText(params.prompt));
  }

  async cancel(params: CancelNotification): Promise<void> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) return;
    await entry.session.interrupt();
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    await session.setPermissionMode(params.modeId as PermissionMode);
    this.conn.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      } as SessionUpdate,
    }).catch(() => {});
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    const value = String(params.value);

    switch (params.configId) {
      case "model":
        await session.setModel(value);
        break;
      case "permission_mode":
        await session.setPermissionMode(value as PermissionMode);
        this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: value,
          } as SessionUpdate,
        }).catch(() => {});
        break;
      default:
        throw new Error(`unknown config option: ${params.configId}`);
    }

    return {
      configOptions: buildConfigOptions(session.model, session.permissionMode),
    };
  }

  private requireSession(sessionId: string): ClaudrabandSession {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`session ${sessionId} not found`);
    }
    return entry.session;
  }

  private attachSession(session: ClaudrabandSession): void {
    (async () => {
      for await (const event of session.events()) {
        this.sendEvent(session.sessionId, event);
      }
    })().catch((err: unknown) => {
      this.log.error("session event loop failed", "sid", session.sessionId, err);
    });
  }

  private sendEvent(sessionId: string, event: ClaudrabandEvent): void {
    let update: SessionUpdate | null = null;

    switch (event.kind) {
      case EventKind.AssistantText:
        update = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.text },
        };
        break;
      case EventKind.AssistantThinking:
      case EventKind.System:
        if (!event.text) return;
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.text },
        };
        break;
      case EventKind.UserMessage:
        return;
      case EventKind.ToolCall: {
        let rawInput: Record<string, unknown> | undefined;
        try {
          rawInput = JSON.parse(event.toolInput) as Record<string, unknown>;
        } catch {
          rawInput = undefined;
        }

        const toolCallObj: Record<string, unknown> = {
          sessionUpdate: "tool_call",
          toolCallId: event.toolID,
          title: event.toolName,
          kind: mapToolKind(event.toolName),
          status: "pending",
        };
        if (rawInput) {
          toolCallObj.rawInput = rawInput;
        }
        const locations = extractLocations(event.toolInput);
        if (locations) {
          toolCallObj.locations = locations;
        }
        update = toolCallObj as SessionUpdate;
        break;
      }
      case EventKind.ToolResult: {
        const content: ToolCallContent[] = [
          {
            type: "content",
            content: { type: "text", text: event.text },
          } as ToolCallContent,
        ];
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolID,
          status: "completed",
          content,
        } as SessionUpdate;
        break;
      }
      case EventKind.Error:
        update = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Error: ${event.text}` },
        };
        break;
      default:
        return;
    }

    this.conn.sessionUpdate({ sessionId, update }).catch((err: unknown) => {
      this.log.error("failed to send session update", "sid", sessionId, err);
    });
  }

  private async handlePermissionRequest(
    request: ClaudrabandPermissionRequest,
  ): Promise<ClaudrabandPermissionDecision> {
    const content: ToolCallContent[] = request.content.map((block) => ({
      type: "content",
      content: block as unknown as ContentBlock,
    })) as ToolCallContent[];

    const options: PermissionOption[] = request.options
      .filter((option) => !option.textInput)
      .map((option) => ({
      kind: option.kind,
      optionId: option.optionId,
      name: option.name,
    }));

    const response = await this.conn.requestPermission({
      sessionId: request.sessionId,
      toolCall: {
        toolCallId: request.toolCallId,
        title: request.title,
        kind: request.kind,
        status: "pending",
        content,
      },
      options,
    });

    if (response.outcome.outcome === "selected") {
      return {
        outcome: "selected",
        optionId: response.outcome.optionId,
      };
    }

    return { outcome: "cancelled" };
  }
}

function extractPromptText(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return "";
  let text = "";
  for (const block of blocks) {
    if ("text" in block && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}
