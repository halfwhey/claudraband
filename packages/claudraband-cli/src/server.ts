import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createClaudraband,
  type Claudraband,
  type ClaudrabandEvent,
  type ClaudrabandLogger,
  type ClaudrabandPermissionDecision,
  type ClaudrabandPermissionRequest,
  type ClaudrabandSession,
  type SessionSummary,
  EventKind,
} from "claudraband-core";
import type { CliConfig } from "./args";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeDeadSessionError(msg: string): boolean {
  return (
    /can't find pane/i.test(msg) ||
    /no such (window|pane)/i.test(msg) ||
    /session .* is not live/i.test(msg) ||
    /terminal is not started/i.test(msg) ||
    /claude: not started/i.test(msg) ||
    /pane .* not found/i.test(msg) ||
    /pty .* exited/i.test(msg)
  );
}

interface DaemonSession {
  session: ClaudrabandSession;
  sseClients: Set<ServerResponse>;
  pendingPermission: {
    request: ClaudrabandPermissionRequest;
    resolve: (decision: ClaudrabandPermissionDecision) => void;
  } | null;
  lastEventSeq: number;
}

interface SessionRequestBody {
  sessionId?: string;
  cwd?: string;
  claudeArgs?: string[];
  model?: string;
  permissionMode?: string;
  requireLive?: boolean;
}

function parseOptionalJsonObject<T = Record<string, unknown>>(
  rawBody: string,
): T {
  if (!rawBody.trim()) {
    return {} as T;
  }
  return JSON.parse(rawBody) as T;
}

function resolveSessionConfig(
  config: CliConfig,
  body: SessionRequestBody,
): {
  cwd: string;
  claudeArgs: string[];
  model: string;
  permissionMode: string;
} {
  return {
    cwd: body.cwd ?? config.cwd,
    claudeArgs: body.claudeArgs ?? config.claudeArgs,
    model: body.model ?? config.model,
    permissionMode: body.permissionMode ?? config.permissionMode,
  };
}

function shouldReuseSession(
  ds: DaemonSession | null,
) : boolean {
  return ds !== null && ds.session.isProcessAlive();
}

function resolveServerTerminalBackend(config: CliConfig): CliConfig["terminalBackend"] {
  return config.hasExplicitTerminalBackend ? config.terminalBackend : "tmux";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

interface DaemonServerHandle {
  server: ReturnType<typeof createServer>;
  sessions: Map<string, DaemonSession>;
  close(): Promise<void>;
}

function sessionSummaryToJson(session: SessionSummary): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    backend: session.backend,
    source: session.source,
    alive: session.alive,
    reattachable: session.reattachable,
    owner: session.owner,
  };
}

function extractLastAssistantTurn(events: ClaudrabandEvent[]): string | null {
  const chunks: string[] = [];
  let inLastTurn = false;
  // Iterate newest-to-oldest. Enter "last turn" on the final TurnEnd.
  // Leave the turn on any upstream signal that a new turn is starting:
  // an earlier TurnEnd, a TurnStart, or a UserMessage.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === EventKind.TurnEnd) {
      if (inLastTurn) break;
      inLastTurn = true;
      continue;
    }
    if (!inLastTurn) continue;
    if (
      ev.kind === EventKind.TurnStart ||
      ev.kind === EventKind.UserMessage
    ) {
      break;
    }
    if (ev.kind === EventKind.AssistantText) {
      chunks.unshift(ev.text);
    }
  }
  return chunks.length === 0 ? null : chunks.join("");
}

function createDaemonServer(
  config: CliConfig,
  runtime: Claudraband,
  logger: ClaudrabandLogger,
): DaemonServerHandle {
  const serverInstanceId = randomUUID();
  const serverUrl = `http://${formatHostForUrl(config.host)}:${config.port}`;

  const sessions = new Map<string, DaemonSession>();

  function getSession(id: string): DaemonSession | null {
    return sessions.get(id) ?? null;
  }

  function attachEventStream(ds: DaemonSession): void {
    (async () => {
      for await (const event of ds.session.events()) {
        broadcastSse(ds, eventToJson(event));
      }
    })().catch(() => {});
  }

  function broadcastSse(
    ds: DaemonSession,
    payload: Record<string, unknown>,
  ): number {
    ds.lastEventSeq++;
    const data = JSON.stringify({
      seq: ds.lastEventSeq,
      ...payload,
    });
    for (const res of ds.sseClients) {
      res.write(`data: ${data}\n\n`);
    }
    return ds.lastEventSeq;
  }

  async function handlePermission(
    ds: DaemonSession,
    request: ClaudrabandPermissionRequest,
  ): Promise<ClaudrabandPermissionDecision> {
    return new Promise<ClaudrabandPermissionDecision>((resolve) => {
      ds.pendingPermission = { request, resolve };
      broadcastSse(ds, {
        type: "permission_request",
        ...request,
      });
    });
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString();
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function err(res: ServerResponse, status: number, message: string): void {
    json(res, status, { error: message });
  }

  function requireLiveSession(
    res: ServerResponse,
    sessionId: string,
    ds: DaemonSession,
  ): boolean {
    if (ds.session.isProcessAlive()) {
      return true;
    }
    // Session is dead; drop it from tracking so subsequent requests see 404
    // instead of 409, matching the registry-backed view.
    dropDeadSession(sessionId, ds);
    err(res, 409, `session ${sessionId} is not live`);
    return false;
  }

  function dropDeadSession(sessionId: string, ds: DaemonSession): void {
    if (sessions.get(sessionId) !== ds) return;
    sessions.delete(sessionId);
    ds.pendingPermission?.resolve({ outcome: "cancelled" });
    ds.pendingPermission = null;
    for (const client of ds.sseClients) {
      try { client.end(); } catch { /* client already gone */ }
    }
    ds.sseClients.clear();
    // Best-effort detach so the runtime releases any tailer/file handles
    // held for this session.
    void ds.session.detach().catch(() => {});
  }

  async function runSessionOp<T>(
    res: ServerResponse,
    sessionId: string,
    ds: DaemonSession,
    op: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await op();
      return { ok: true, value };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // If the underlying terminal died between the live-check and the op,
      // or if the error itself indicates a dead backend, return a clean 409
      // rather than leaking the raw tmux/pty error as a 500.
      if (!ds.session.isProcessAlive() || looksLikeDeadSessionError(message)) {
        dropDeadSession(sessionId, ds);
        err(res, 409, `session ${sessionId} is not live`);
        return { ok: false };
      }
      throw e;
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // POST /sessions -- create new session
      if (method === "POST" && path === "/sessions") {
        const body = parseOptionalJsonObject<SessionRequestBody>(await readBody(req));
        if (body.sessionId !== undefined && !UUID_RE.test(body.sessionId)) {
          err(
            res,
            400,
            `sessionId must be a UUID (got ${JSON.stringify(body.sessionId)})`,
          );
          return;
        }
        const sessionConfig = resolveSessionConfig(config, body);
        const sessionOwner = {
          kind: "daemon" as const,
          serverUrl,
          serverPid: process.pid,
          serverInstanceId,
        };
        const session = body.sessionId
          ? await runtime.resumeSession(body.sessionId, {
            cwd: sessionConfig.cwd,
            claudeArgs: sessionConfig.claudeArgs,
            model: sessionConfig.model,
            permissionMode: sessionConfig.permissionMode as typeof config.permissionMode,
            allowTextResponses: true,
            logger,
            sessionOwner,
            onPermissionRequest: (request) =>
              handlePermission(ds, request),
          })
          : await runtime.startSession({
            cwd: sessionConfig.cwd,
            claudeArgs: sessionConfig.claudeArgs,
            model: sessionConfig.model,
            permissionMode: sessionConfig.permissionMode as typeof config.permissionMode,
            allowTextResponses: true,
            logger,
            sessionOwner,
            onPermissionRequest: (request) =>
              handlePermission(ds, request),
          });
        const ds: DaemonSession = {
          session,
          sseClients: new Set(),
          pendingPermission: null,
          lastEventSeq: 0,
        };
        sessions.set(session.sessionId, ds);
        attachEventStream(ds);
        json(res, 201, {
          sessionId: session.sessionId,
          backend: session.backend,
        });
        return;
      }

      // GET /sessions -- list active daemon sessions
      if (method === "GET" && path === "/sessions") {
        const list = [];
        // Take a snapshot before iterating so we can drop dead entries as
        // we go without mutating the map during iteration.
        for (const [id, ds] of [...sessions.entries()]) {
          const alive = ds.session.isProcessAlive();
          if (!alive) {
            dropDeadSession(id, ds);
            continue;
          }
          list.push({
            sessionId: id,
            alive,
            hasPendingPermission: ds.pendingPermission !== null,
          });
        }
        json(res, 200, { sessions: list });
        return;
      }

      // Routes with session ID: /sessions/:id/...
      const match = path.match(/^\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (!match) {
        err(res, 404, "not found");
        return;
      }

      const sessionId = match[1];
      const action = match[2] ?? "";
      const cwd = url.searchParams.get("cwd") ?? undefined;

      // GET /sessions/:id/status
      if (method === "GET" && action === "status") {
        const session = await runtime.inspectSession(sessionId, cwd);
        if (!session) {
          err(res, 404, `session ${sessionId} not found`);
          return;
        }
        json(res, 200, sessionSummaryToJson(session));
        return;
      }

      // GET /sessions/:id/last
      if (method === "GET" && action === "last") {
        const session = await runtime.inspectSession(sessionId, cwd);
        if (!session) {
          err(res, 404, `session ${sessionId} not found`);
          return;
        }
        const events = await runtime.replaySession(sessionId, session.cwd);
        const text = extractLastAssistantTurn(events);
        if (text === null) {
          err(res, 404, `no assistant message found for session ${sessionId}`);
          return;
        }
        json(res, 200, {
          sessionId,
          cwd: session.cwd,
          text,
        });
        return;
      }

      // POST /sessions/:id/resume
      if (method === "POST" && action === "resume") {
        if (!UUID_RE.test(sessionId)) {
          err(res, 400, `sessionId must be a UUID (got ${JSON.stringify(sessionId)})`);
          return;
        }
        const body = parseOptionalJsonObject<SessionRequestBody>(await readBody(req));
        const ds = getSession(sessionId);
        if (ds && shouldReuseSession(ds)) {
          json(res, 200, {
            sessionId,
            reattached: true,
            backend: ds.session.backend,
          });
          return;
        }
        if (ds) {
          dropDeadSession(sessionId, ds);
        }
        // Look up the session's recorded cwd so a body-less resume targets
        // the right project transcript. Also fast-fail unknown ids instead
        // of blocking on a doomed `claude --resume` attempt.
        const known = await runtime.inspectSession(sessionId, body.cwd);
        if (!known && !body.cwd) {
          err(
            res,
            404,
            `session ${sessionId} not found; provide cwd to attempt a cold resume`,
          );
          return;
        }
        if (body.requireLive) {
          err(res, 409, `session ${sessionId} is not live on the daemon`);
          return;
        }
        const effectiveBody: SessionRequestBody = {
          ...body,
          cwd: body.cwd ?? known?.cwd,
        };
        const sessionConfig = resolveSessionConfig(config, effectiveBody);
        const session = await runtime.resumeSession(sessionId, {
          cwd: sessionConfig.cwd,
          claudeArgs: sessionConfig.claudeArgs,
          model: sessionConfig.model,
          permissionMode: sessionConfig.permissionMode as typeof config.permissionMode,
          allowTextResponses: true,
          logger,
          sessionOwner: {
            kind: "daemon",
            serverUrl,
            serverPid: process.pid,
            serverInstanceId,
          },
          onPermissionRequest: (request) =>
            handlePermission(newDs, request),
        });
        const newDs: DaemonSession = {
          session,
          sseClients: new Set(),
          pendingPermission: null,
          lastEventSeq: 0,
        };
        sessions.set(sessionId, newDs);
        attachEventStream(newDs);
        json(res, 200, {
          sessionId,
          reattached: false,
          backend: session.backend,
        });
        return;
      }

      const ds = getSession(sessionId);
      if (!ds) {
        err(res, 404, `session ${sessionId} not found`);
        return;
      }

      // GET /sessions/:id/events -- SSE
      if (method === "GET" && action === "events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        ds.sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
        // Send pending permission if any.
        if (ds.pendingPermission) {
          const data = JSON.stringify({
            type: "permission_request",
            ...ds.pendingPermission.request,
          });
          res.write(`data: ${data}\n\n`);
        }
        req.on("close", () => {
          ds.sseClients.delete(res);
        });
        return;
      }

      // POST /sessions/:id/prompt
      if (method === "POST" && action === "prompt") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const body = JSON.parse(await readBody(req)) as { text: string };
        const outcome = await runSessionOp(res, sessionId, ds, async () => {
          const result = await ds.session.prompt(body.text);
          await ds.session.flushEvents();
          return result;
        });
        if (!outcome.ok) return;
        json(res, 200, {
          ...outcome.value,
          eventSeq: ds.lastEventSeq,
        });
        return;
      }

      // POST /sessions/:id/await-turn
      if (method === "POST" && action === "await-turn") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const outcome = await runSessionOp(res, sessionId, ds, async () => {
          const result = await ds.session.awaitTurn();
          await ds.session.flushEvents();
          return result;
        });
        if (!outcome.ok) return;
        json(res, 200, {
          ...outcome.value,
          eventSeq: ds.lastEventSeq,
        });
        return;
      }

      // POST /sessions/:id/send
      if (method === "POST" && action === "send") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const body = JSON.parse(await readBody(req)) as { text: string };
        const outcome = await runSessionOp(res, sessionId, ds, () =>
          ds.session.send(body.text),
        );
        if (!outcome.ok) return;
        json(res, 200, { ok: true });
        return;
      }

      // POST /sessions/:id/send-and-await-turn
      if (method === "POST" && action === "send-and-await-turn") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const body = JSON.parse(await readBody(req)) as { text: string };
        const outcome = await runSessionOp(res, sessionId, ds, async () => {
          const result = await ds.session.sendAndAwaitTurn(body.text);
          await ds.session.flushEvents();
          return result;
        });
        if (!outcome.ok) return;
        json(res, 200, {
          ...outcome.value,
          eventSeq: ds.lastEventSeq,
        });
        return;
      }

      // POST /sessions/:id/interrupt
      if (method === "POST" && action === "interrupt") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const outcome = await runSessionOp(res, sessionId, ds, () =>
          ds.session.interrupt(),
        );
        if (!outcome.ok) return;
        json(res, 200, { ok: true });
        return;
      }

      // DELETE /sessions/:id -- stop (kill)
      if (method === "DELETE" && !action) {
        ds.pendingPermission?.resolve({ outcome: "cancelled" });
        ds.pendingPermission = null;
        await ds.session.stop();
        sessions.delete(sessionId);
        for (const client of ds.sseClients) {
          client.end();
        }
        json(res, 200, { ok: true });
        return;
      }

      // POST /sessions/:id/permission
      if (method === "POST" && action === "permission") {
        if (!ds.pendingPermission) {
          err(res, 409, "no pending permission request");
          return;
        }
        const body = JSON.parse(await readBody(req)) as ClaudrabandPermissionDecision;
        ds.pendingPermission.resolve(body);
        ds.pendingPermission = null;
        json(res, 200, { ok: true });
        return;
      }

      // GET /sessions/:id/pending-question
      if (method === "GET" && action === "pending-question") {
        if (ds.pendingPermission !== null) {
          json(res, 200, { pending: true, source: "permission_request" });
          return;
        }
        const pendingState = await ds.session.hasPendingInput();
        json(res, 200, {
          pending: pendingState.pending,
          source: pendingState.source,
        });
        return;
      }

      err(res, 404, "not found");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("request error", method, path, msg);
      err(res, 500, msg);
    }
  });

  return {
    server,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const [, ds] of sessions) {
          ds.session.detach().catch(() => {});
        }
        server.close(() => resolve());
      }),
  };
}

export async function startServer(config: CliConfig): Promise<void> {
  const logger: ClaudrabandLogger = {
    info: (msg, ...args) => process.stderr.write(`info: ${msg} ${args.join(" ")}\n`),
    debug: (msg, ...args) => {
      if (config.debug) process.stderr.write(`debug: ${msg} ${args.join(" ")}\n`);
    },
    warn: (msg, ...args) => process.stderr.write(`warn: ${msg} ${args.join(" ")}\n`),
    error: (msg, ...args) => process.stderr.write(`error: ${msg} ${args.join(" ")}\n`),
  };

  const runtime = createClaudraband({
    claudeArgs: config.claudeArgs,
    model: config.model,
    permissionMode: config.permissionMode,
    terminalBackend: resolveServerTerminalBackend(config),
    logger,
  });

  const handle = createDaemonServer(config, runtime, logger);

  handle.server.listen(config.port, config.host, () => {
    logger.info(
      `claudraband daemon listening on ${config.host}:${config.port}`,
    );
  });

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      logger.info("shutting down daemon");
      handle.close().then(resolve);
    });
    process.on("SIGTERM", () => {
      logger.info("shutting down daemon");
      handle.close().then(resolve);
    });
  });
}

export const __test = {
  formatHostForUrl,
  parseOptionalJsonObject,
  resolveSessionConfig,
  resolveServerTerminalBackend,
  shouldReuseSession,
  sessionSummaryToJson,
  extractLastAssistantTurn,
  createDaemonServer,
};

function eventToJson(event: ClaudrabandEvent): Record<string, unknown> {
  return {
    kind: event.kind,
    time: event.time.toISOString(),
    text: event.text,
    toolName: event.toolName || undefined,
    toolID: event.toolID || undefined,
    toolInput: event.toolInput || undefined,
    role: event.role || undefined,
  };
}
