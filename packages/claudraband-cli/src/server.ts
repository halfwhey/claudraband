import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createClaudraband,
  SessionNotFoundError,
  type Claudraband,
  type ClaudrabandEvent,
  type ClaudrabandLogger,
  type ClaudrabandPermissionDecision,
  type ClaudrabandPermissionRequest,
  type ClaudrabandSession,
  type SessionStatus,
  type TurnDetectionMode,
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
  turnDetection?: TurnDetectionMode;
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
  turnDetection: TurnDetectionMode;
} {
  return {
    cwd: body.cwd ?? config.cwd,
    claudeArgs: body.claudeArgs ?? config.claudeArgs,
    model: body.model ?? config.model,
    permissionMode: body.permissionMode ?? config.permissionMode,
    turnDetection: body.turnDetection ?? config.turnDetection,
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

function sessionStatusToJson(status: SessionStatus): Record<string, unknown> {
  return {
    sessionId: status.sessionId,
    cwd: status.cwd,
    title: status.title,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    backend: status.backend,
    source: status.source,
    alive: status.alive,
    reattachable: status.reattachable,
    owner: status.owner,
    turnInProgress: status.turnInProgress,
    pendingInput: status.pendingInput,
  };
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
      // POST /sessions -- create new session or resume a saved one
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

        // If we already own a live daemon session with this id, reattach.
        if (body.sessionId) {
          const existing = getSession(body.sessionId);
          if (existing && shouldReuseSession(existing)) {
            json(res, 200, {
              sessionId: body.sessionId,
              backend: existing.session.backend,
              resumed: true,
            });
            return;
          }
          if (existing) {
            dropDeadSession(body.sessionId, existing);
          }
        }

        const sessionConfig = resolveSessionConfig(config, body);
        const sessionOwner = {
          kind: "daemon" as const,
          serverUrl,
          serverPid: process.pid,
          serverInstanceId,
        };
        const ds: DaemonSession = {
          session: null as unknown as ClaudrabandSession,
          sseClients: new Set(),
          pendingPermission: null,
          lastEventSeq: 0,
        };
        let session: ClaudrabandSession;
        try {
          session = await runtime.openSession({
            sessionId: body.sessionId,
            cwd: sessionConfig.cwd,
            claudeArgs: sessionConfig.claudeArgs,
            model: sessionConfig.model,
            permissionMode: sessionConfig.permissionMode as typeof config.permissionMode,
            turnDetection: sessionConfig.turnDetection,
            allowTextResponses: true,
            logger,
            sessionOwner,
            onPermissionRequest: (request: ClaudrabandPermissionRequest) =>
              handlePermission(ds, request),
          });
        } catch (e: unknown) {
          if (e instanceof SessionNotFoundError) {
            err(res, 404, e.message);
            return;
          }
          throw e;
        }
        ds.session = session;
        sessions.set(session.sessionId, ds);
        attachEventStream(ds);
        json(res, 201, {
          sessionId: session.sessionId,
          backend: session.backend,
          resumed: Boolean(body.sessionId),
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
        const status = await runtime.getStatus(sessionId, cwd);
        if (!status) {
          err(res, 404, `session ${sessionId} not found`);
          return;
        }
        json(res, 200, sessionStatusToJson(status));
        return;
      }

      // GET /sessions/:id/last
      if (method === "GET" && action === "last") {
        const summary = await runtime.inspectSession(sessionId, cwd);
        if (!summary) {
          err(res, 404, `session ${sessionId} not found`);
          return;
        }
        const text = await runtime.getLastMessage(sessionId, summary.cwd);
        if (text === null) {
          err(res, 404, `no assistant message found for session ${sessionId}`);
          return;
        }
        json(res, 200, {
          sessionId,
          cwd: summary.cwd,
          text,
        });
        return;
      }

      const ds = getSession(sessionId);
      if (!ds) {
        err(res, 404, `session ${sessionId} not found`);
        return;
      }

      // GET /sessions/:id/watch -- SSE
      if (method === "GET" && action === "watch") {
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
      // Body: { text?: string, select?: string }
      // - select+text: answer the pending question with `select`, then wait for
      //   the turn that follows. The optional `text` is sent after the choice
      //   (used for the "Other" sentinel "0").
      // - select only: same, no follow-up text.
      // - text only: standard prompt + wait.
      if (method === "POST" && action === "prompt") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const body = parseOptionalJsonObject<{ text?: string; select?: string }>(
          await readBody(req),
        );
        if (!body.text && !body.select) {
          err(res, 400, "prompt requires `text` or `select` in the request body");
          return;
        }
        const outcome = await runSessionOp(res, sessionId, ds, async () => {
          const result = body.select
            ? await ds.session.answerPending(body.select, body.text)
            : await ds.session.prompt(body.text!);
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
      // Body: { text?: string, select?: string }
      // Fire-and-forget mirror of /prompt. With `select`, the choice is sent
      // first, then the optional `text` (matching `cband send --select`).
      if (method === "POST" && action === "send") {
        if (!requireLiveSession(res, sessionId, ds)) return;
        const body = parseOptionalJsonObject<{ text?: string; select?: string }>(
          await readBody(req),
        );
        if (!body.text && !body.select) {
          err(res, 400, "send requires `text` or `select` in the request body");
          return;
        }
        const outcome = await runSessionOp(res, sessionId, ds, async () => {
          if (body.select) {
            await ds.session.send(body.select);
          }
          if (body.text) {
            await ds.session.send(body.text);
          }
        });
        if (!outcome.ok) return;
        json(res, 200, { ok: true });
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
    turnDetection: config.turnDetection,
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
  sessionStatusToJson,
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
