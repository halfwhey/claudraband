import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type {
  Claudraband,
  ClaudrabandEvent,
  ClaudeAccountStateErrorKind,
  ClaudrabandPermissionRequest,
  ClaudrabandSession,
  OpenSessionOptions,
  PromptResult,
  SessionStatus,
  SessionSummary,
} from "claudraband-core";
import {
  ClaudeAccountStateError,
  ClaudeStartupError,
  EventKind,
  SessionNotFoundError,
} from "claudraband-core";
import type { CliConfig } from "./args";
import { __test } from "./server";

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    command: "serve",
    prompt: "",
    sessionId: "",
    answer: "",
    allSessions: false,
    cwd: "/test-cwd",
    hasExplicitCwd: false,
    debug: false,
    json: false,
    pretty: false,
    follow: true,
    claudeArgs: [],
    hasExplicitClaudeArgs: false,
    hasExplicitModel: false,
    hasExplicitPermissionMode: false,
    autoAcceptStartupPrompts: false,
    hasExplicitTerminalBackend: false,
    hasExplicitTurnDetection: false,
    model: "haiku",
    permissionMode: "default",
    terminalBackend: "xterm",
    turnDetection: "terminal",
    connect: "",
    host: "127.0.0.1",
    port: 0, // random port
    warnings: [],
    ...overrides,
  };
}

interface MockState {
  alive: boolean;
  lastText: string | null;
  pendingInput: SessionStatus["pendingInput"];
  turnInProgress: boolean;
  permissionHandler?: OpenSessionOptions["onPermissionRequest"];
  openSessionError: Error | null;
}

interface MockSession extends ClaudrabandSession {
  awaitTurn(): Promise<PromptResult>;
}

interface MockRuntime extends Claudraband {
  _lastSession: MockSession | null;
  _state: MockState;
  _triggerPermission(request: ClaudrabandPermissionRequest): Promise<void>;
}

function makeMockEvent(
  kind: ClaudrabandEvent["kind"],
  text = "",
): ClaudrabandEvent {
  return {
    kind,
    time: new Date("2026-04-12T10:00:00.000Z"),
    text,
    toolName: "",
    toolID: "",
    toolInput: "",
    role: kind === EventKind.AssistantText ? "assistant" : "",
  };
}

function makeMockSession(id: string, state: MockState): MockSession {
  const subscribers = new Set<{
    queue: ClaudrabandEvent[];
    resolvers: Array<(result: IteratorResult<ClaudrabandEvent>) => void>;
    closed: boolean;
  }>();
  const turnWaiters: Array<() => void> = [];

  function emit(event: ClaudrabandEvent): void {
    for (const subscriber of subscribers) {
      if (subscriber.closed) continue;
      const resolver = subscriber.resolvers.shift();
      if (resolver) {
        resolver({ value: event, done: false });
      } else {
        subscriber.queue.push(event);
      }
    }
    if (event.kind === EventKind.TurnEnd) {
      state.turnInProgress = false;
      for (const resolve of turnWaiters.splice(0)) {
        resolve();
      }
    }
  }

  function closeSubscribers(): void {
    for (const subscriber of subscribers) {
      subscriber.closed = true;
      for (const resolve of subscriber.resolvers.splice(0)) {
        resolve({ value: undefined, done: true } as IteratorResult<ClaudrabandEvent>);
      }
    }
    subscribers.clear();
  }

  function emitAssistantTurn(text: string): void {
    state.lastText = text;
    state.turnInProgress = true;
    emit(makeMockEvent(EventKind.AssistantText, text));
    emit(makeMockEvent(EventKind.TurnEnd));
  }

  return {
    sessionId: id,
    cwd: "/test-cwd",
    backend: "xterm" as const,
    model: "haiku",
    permissionMode: "default",
    async *events() {
      const subscriber = {
        queue: [] as ClaudrabandEvent[],
        resolvers: [] as Array<(result: IteratorResult<ClaudrabandEvent>) => void>,
        closed: false,
      };
      subscribers.add(subscriber);
      try {
        while (true) {
          if (subscriber.queue.length > 0) {
            yield subscriber.queue.shift()!;
            continue;
          }
          if (subscriber.closed) return;
          const next = await new Promise<IteratorResult<ClaudrabandEvent>>((resolve) => {
            subscriber.resolvers.push(resolve);
          });
          if (next.done) return;
          yield next.value;
        }
      } finally {
        subscriber.closed = true;
        subscribers.delete(subscriber);
      }
    },
    async prompt(text: string): Promise<PromptResult> {
      state.pendingInput = "none";
      emitAssistantTurn(`reply: ${text}`);
      return { stopReason: "end_turn" };
    },
    async send(_text: string) {
      if (state.pendingInput === "question") {
        state.pendingInput = "none";
      }
    },
    async answerPending(choice: string, text?: string): Promise<PromptResult> {
      state.pendingInput = "none";
      emitAssistantTurn(text ? `selected ${choice}: ${text}` : `selected ${choice}`);
      return { stopReason: "end_turn" };
    },
    async awaitTurn(): Promise<PromptResult> {
      if (!state.turnInProgress) {
        return { stopReason: "end_turn" };
      }
      await new Promise<void>((resolve) => {
        turnWaiters.push(resolve);
      });
      return { stopReason: "end_turn" };
    },
    async interrupt() {
      state.turnInProgress = false;
      for (const resolve of turnWaiters.splice(0)) {
        resolve();
      }
    },
    async stop() {
      state.alive = false;
      state.turnInProgress = false;
      closeSubscribers();
    },
    async detach() {},
    isProcessAlive() {
      return state.alive;
    },
    async capturePane() {
      return "";
    },
    async hasPendingInput() {
      return {
        pending: state.pendingInput !== "none",
        source: state.pendingInput,
      };
    },
    async setModel() {},
    async setPermissionMode() {},
    async flushEvents() {
      while ([...subscribers].some((subscriber) => subscriber.queue.length > 0)) {
        await Promise.resolve();
      }
    },
  };
}

function makeMockRuntime(): MockRuntime {
  const state: MockState = {
    alive: true,
    lastText: "latest answer",
    pendingInput: "none",
    turnInProgress: false,
    openSessionError: null,
  };

  const rt: MockRuntime = {
    _lastSession: null,
    _state: state,
    async _triggerPermission(request: ClaudrabandPermissionRequest) {
      state.pendingInput = "permission";
      state.turnInProgress = true;
      const handler = state.permissionHandler;
      if (!handler) return;
      const decision = await handler(request);
      if (decision.outcome === "deferred") {
        return;
      }
      state.pendingInput = "none";
      if (decision.outcome === "selected") {
        const session = rt._lastSession as MockSession | null;
        if (session) {
          await session.answerPending(decision.optionId);
        }
        return;
      }
      if (decision.outcome === "text") {
        const session = rt._lastSession as MockSession | null;
        if (session) {
          await session.answerPending("text", decision.text);
        }
        return;
      }
      state.turnInProgress = false;
    },
    async openSession(options?: OpenSessionOptions) {
      if (state.openSessionError) {
        throw state.openSessionError;
      }
      const id = options?.sessionId ?? randomUUID();
      if (options?.sessionId && rt._lastSession?.sessionId !== options.sessionId) {
        throw new SessionNotFoundError(options.sessionId);
      }
      state.alive = true;
      state.permissionHandler = options?.onPermissionRequest;
      const session = makeMockSession(id, state);
      rt._lastSession = session;
      return session;
    },
    async listSessions() {
      return [];
    },
    async inspectSession(sessionId: string) {
      if (rt._lastSession?.sessionId !== sessionId) {
        return null;
      }
      const session: SessionSummary = {
        sessionId,
        cwd: rt._lastSession.cwd,
        title: "Mock session",
        createdAt: "2026-04-12T10:00:00.000Z",
        updatedAt: "2026-04-12T10:05:00.000Z",
        backend: rt._lastSession.backend,
        source: "live",
        alive: rt._lastSession.isProcessAlive(),
        reattachable: true,
        owner: {
          kind: "daemon",
          serverUrl: "http://127.0.0.1:7842",
          serverPid: 12345,
          serverInstanceId: "daemon-1",
        },
      };
      return session;
    },
    async getStatus(sessionId: string) {
      const summary = await rt.inspectSession(sessionId);
      if (!summary) return null;
      const status: SessionStatus = {
        ...summary,
        turnInProgress: state.turnInProgress,
        pendingInput: state.pendingInput,
      };
      return status;
    },
    async getLastMessage(sessionId: string) {
      if (rt._lastSession?.sessionId !== sessionId) {
        return null;
      }
      return state.lastText;
    },
    async closeSession() {
      return true;
    },
    async replaySession(sessionId) {
      if (rt._lastSession?.sessionId !== sessionId || state.lastText === null) {
        return [];
      }
      return [
        makeMockEvent(EventKind.TurnStart),
        makeMockEvent(EventKind.AssistantText, state.lastText),
        makeMockEvent(EventKind.TurnEnd),
      ];
    },
  };
  return rt;
}

const noopLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

type ServerHandle = ReturnType<typeof __test.createDaemonServer>;

let handle: ServerHandle;
let baseUrl: string;

function startTestServer(configOverrides: Partial<CliConfig> = {}) {
  const config = makeConfig(configOverrides);
  const runtime = makeMockRuntime();
  handle = __test.createDaemonServer(config, runtime, noopLogger);
  return new Promise<{ baseUrl: string; runtime: ReturnType<typeof makeMockRuntime> }>((resolve) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const addr = handle.server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ baseUrl, runtime });
    });
  });
}

async function stopTestServer() {
  if (handle) await handle.close();
}

describe("daemon HTTP API", () => {
  afterEach(async () => {
    await stopTestServer();
  });

  // --- Routing ---

  test("unknown route returns 404", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/bogus`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  // --- POST /sessions ---

  test("create session returns sessionId and backend", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeString();
    expect(body.backend).toBe("xterm");
    expect(body.pendingInput).toBe("none");
  });

  test("create session returns pendingInput for a startup-blocked permission prompt", async () => {
    const { runtime } = await startTestServer();
    runtime._state.pendingInput = "permission";

    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pendingInput).toBe("permission");
  });

  test("create session accepts an empty request body", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeString();
    expect(body.backend).toBe("xterm");
  });

  test("create session rejects a non-UUID caller-provided sessionId", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("UUID");
  });

  test("create session returns 409 when Claude account state is not ready", async () => {
    const { runtime } = await startTestServer();
    runtime._state.openSessionError = new ClaudeAccountStateError(
      "not_onboarded" satisfies ClaudeAccountStateErrorKind,
      "Claude account state is not onboarded yet.",
      {
        homeDir: "/home/claude",
        claudeDir: "/home/claude/.claude",
        claudeJsonPath: "/home/claude/.claude.json",
        credentialsPath: "/home/claude/.claude/.credentials.json",
      },
    );

    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("not onboarded");
  });

  test("create session returns 409 when Claude exits during startup", async () => {
    const { runtime } = await startTestServer();
    runtime._state.openSessionError = new ClaudeStartupError(
      "Claude exited during startup. Last pane output: permission error",
    );

    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Claude exited during startup");
  });

  // --- GET /sessions ---

  test("list sessions returns empty array initially", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toEqual([]);
  });

  test("list sessions includes created session", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const listRes = await fetch(`${baseUrl}/sessions`);
    const body = await listRes.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe(sessionId);
    expect(body.sessions[0].alive).toBe(true);
    expect(body.sessions[0].hasPendingPermission).toBe(false);
  });

  // --- Session not found ---

  test("action on non-existent session returns 404", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/bad-id/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // --- GET /sessions/:id/status ---

  test("status returns session summary", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.backend).toBe("xterm");
    expect(body.source).toBe("live");
    expect(body.owner.kind).toBe("daemon");
  });

  test("status surfaces daemon-held permission prompts", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    void runtime._triggerPermission({
      source: "native_prompt",
      sessionId,
      toolCallId: "tool_1",
      title: "Run bash command",
      kind: "execute",
      content: [{ type: "text", text: "Run bash command" }],
      options: [
        { kind: "allow_once", optionId: "1", name: "Allow" },
        { kind: "reject_once", optionId: "2", name: "Deny" },
      ],
    });
    await Promise.resolve();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pendingInput).toBe("permission");
  });

  test("status returns 404 for unknown session", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/missing/status`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // --- GET /sessions/:id/last ---

  test("last returns last assistant text", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/last`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.cwd).toBe("/test-cwd");
    expect(body.text).toBe("latest answer");
    expect(body.pendingInput).toBe("none");
  });

  test("last returns null text and pending input when no assistant turn is available", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    runtime._state.lastText = null;
    runtime._state.pendingInput = "question";

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/last`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBeNull();
    expect(body.pendingInput).toBe("question");
  });

  test("last returns 404 for unknown session", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/missing/last`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // --- POST /sessions/:id/prompt ---

  test("prompt returns stopReason and assistant text", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopReason).toBe("end_turn");
    expect(body.text).toBe("reply: hello");
    expect(body.pendingInput).toBe("none");
  });

  // --- POST /sessions/:id/send ---

  test("send returns ok", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("send returns 409 when the tracked session is no longer live", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    await runtime._lastSession?.stop();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "2" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("not live");
  });

  // --- POST /sessions/:id/prompt with `select` (replaces removed /answer) ---

  test("prompt with select answers a pending question", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    runtime._state.pendingInput = "question";

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopReason).toBe("end_turn");
    expect(body.text).toBe("selected 1");
    expect(body.pendingInput).toBe("none");
  });

  test("prompt with select+text answers and sends follow-up text", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    runtime._state.pendingInput = "question";

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "0", text: "use the blue theme" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopReason).toBe("end_turn");
    expect(body.text).toBe("selected 0: use the blue theme");
  });

  test("prompt with select answers a pending permission request", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    void runtime._triggerPermission({
      source: "native_prompt",
      sessionId,
      toolCallId: "tool_1",
      title: "Run bash command",
      kind: "execute",
      content: [{ type: "text", text: "Run bash command" }],
      options: [
        { kind: "allow_once", optionId: "1", name: "Allow" },
        { kind: "reject_once", optionId: "2", name: "Deny" },
      ],
    });
    await Promise.resolve();

    const statusRes = await fetch(`${baseUrl}/sessions/${sessionId}/status`);
    const statusBody = await statusRes.json();
    expect(statusBody.pendingInput).toBe("permission");

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopReason).toBe("end_turn");
    expect(body.text).toBe("selected 1");
    expect(body.pendingInput).toBe("none");
  });

  test("prompt with select answers a visible native permission prompt", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    runtime._state.pendingInput = "permission";

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("selected 2");
    expect(body.pendingInput).toBe("none");
  });

  test("prompt without text or select returns 400", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("text");
    expect(body.error).toContain("select");
  });

  test("prompt returns 409 and pendingInput when plain text is sent during a pending question", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    runtime._state.pendingInput = "question";

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.pendingInput).toBe("question");
  });

  test("prompt with select returns 409 when nothing is pending", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "2" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.pendingInput).toBe("none");
  });

  test("send with select fires the choice", async () => {
    const { runtime } = await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();
    runtime._state.pendingInput = "question";

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("send with select returns 409 when nothing is pending", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "2" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.pendingInput).toBe("none");
  });

  test("send without text or select returns 400", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("text");
    expect(body.error).toContain("select");
  });

  test("removed /answer route returns 404", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "1" }),
    });
    expect(res.status).toBe(404);
  });

  // --- POST /sessions/:id/interrupt ---

  test("interrupt returns ok", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/interrupt`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("removed /pending-question route returns 404", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/pending-question`);
    expect(res.status).toBe(404);
  });

  test("removed /permission route returns 404", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select: "1" }),
    });
    expect(res.status).toBe(404);
  });

  // --- DELETE /sessions/:id ---

  test("delete session returns ok", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify session is gone
    const listRes = await fetch(`${baseUrl}/sessions`);
    const listBody = await listRes.json();
    expect(listBody.sessions).toHaveLength(0);
  });

  test("delete non-existent session returns 404", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/bad-id`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  // --- GET /sessions/:id/watch (SSE) ---

  test("watch stream sends ready event", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/watch`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('"type":"ready"');
    controller.abort();
  });

  test("removed /events route returns 404", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/events`);
    expect(res.status).toBe(404);
  });

  // --- POST /sessions with sessionId (resume path) ---

  test("POST /sessions with existing sessionId returns resumed=true", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.resumed).toBe(true);
  });

  test("POST /sessions with unknown sessionId returns 404", async () => {
    await startTestServer();
    const orphanId = randomUUID();
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: orphanId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});
