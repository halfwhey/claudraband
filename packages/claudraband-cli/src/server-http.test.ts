import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type {
  Claudraband,
  ClaudrabandEvent,
  ClaudrabandSession,
  PromptResult,
  SessionSummary,
} from "claudraband-core";
import { EventKind } from "claudraband-core";
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
    claudeArgs: [],
    hasExplicitClaudeArgs: false,
    hasExplicitModel: false,
    hasExplicitPermissionMode: false,
    hasExplicitTerminalBackend: false,
    model: "haiku",
    permissionMode: "default",
    terminalBackend: "xterm",
    connect: "",
    host: "127.0.0.1",
    port: 0, // random port
    warnings: [],
    ...overrides,
  };
}

function makeMockSession(id: string): ClaudrabandSession {
  const events: ClaudrabandEvent[] = [];
  let alive = true;
  return {
    sessionId: id,
    cwd: "/test-cwd",
    backend: "xterm" as const,
    model: "haiku",
    permissionMode: "default",
    async *events() {
      for (const e of events) yield e;
    },
    async prompt(_text: string): Promise<PromptResult> {
      return { stopReason: "end_turn" };
    },
    async awaitTurn(): Promise<PromptResult> {
      return { stopReason: "end_turn" };
    },
    async sendAndAwaitTurn(_text: string): Promise<PromptResult> {
      return { stopReason: "end_turn" };
    },
    async send(_text: string) {},
    async interrupt() {},
    async stop() {
      alive = false;
    },
    async detach() {},
    isProcessAlive() {
      return alive;
    },
    async capturePane() {
      return "";
    },
    async hasPendingInput() {
      return { pending: false as const, source: "none" as const };
    },
    async setModel() {},
    async setPermissionMode() {},
    async flushEvents() {},
  };
}

function makeMockRuntime(): Claudraband & { _lastSession: ClaudrabandSession | null } {
  const rt: Claudraband & { _lastSession: ClaudrabandSession | null } = {
    _lastSession: null,
    async startSession(_options) {
      const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session = makeMockSession(id);
      rt._lastSession = session;
      return session;
    },
    async resumeSession(sessionId, _options) {
      const session = makeMockSession(sessionId);
      rt._lastSession = session;
      return session;
    },
    async listSessions() {
      return [];
    },
    async inspectSession(sessionId) {
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
    async closeSession() {
      return true;
    },
    async replaySession(sessionId) {
      if (rt._lastSession?.sessionId !== sessionId) {
        return [];
      }
      return [
        {
          kind: EventKind.TurnStart,
          time: new Date("2026-04-12T10:00:00.000Z"),
          text: "",
        },
        {
          kind: EventKind.AssistantText,
          time: new Date("2026-04-12T10:00:01.000Z"),
          text: "latest answer",
        },
        {
          kind: EventKind.TurnEnd,
          time: new Date("2026-04-12T10:00:02.000Z"),
          text: "",
        },
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
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeString();
    expect(body.backend).toBe("xterm");
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
  });

  test("last returns 404 for unknown session", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/missing/last`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // --- POST /sessions/:id/prompt ---

  test("prompt returns stopReason", async () => {
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

  // --- POST /sessions/:id/send-and-await-turn ---

  test("send-and-await-turn returns stopReason", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/send-and-await-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopReason).toBe("end_turn");
  });

  // --- POST /sessions/:id/await-turn ---

  test("await-turn returns stopReason", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/await-turn`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stopReason).toBe("end_turn");
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

  // --- GET /sessions/:id/pending-question ---

  test("pending-question returns no pending when none", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/pending-question`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toBe(false);
    expect(body.source).toBe("none");
  });

  // --- POST /sessions/:id/permission ---

  test("permission with none pending returns 409", async () => {
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
      body: JSON.stringify({ outcome: "cancelled" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no pending permission");
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

  // --- GET /sessions/:id/events (SSE) ---

  test("events stream sends ready event", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/events`, {
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

  // --- POST /sessions/:id/resume ---

  test("resume live session returns reattached true", async () => {
    await startTestServer();
    const createRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { sessionId } = await createRes.json();

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.reattached).toBe(true);
  });

  test("resume non-existent session with requireLive returns 409", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/dead-session-id/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requireLive: true }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("not live");
  });

  test("resume non-existent session without requireLive creates new", async () => {
    await startTestServer();
    const res = await fetch(`${baseUrl}/sessions/old-session-id/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("old-session-id");
    expect(body.reattached).toBe(false);
  });
});
