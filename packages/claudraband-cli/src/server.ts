import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createClaudraband,
  hasPendingNativePrompt,
  hasPendingQuestion,
  sessionPath,
  type ClaudrabandEvent,
  type ClaudrabandLogger,
  type ClaudrabandPermissionDecision,
  type ClaudrabandPermissionRequest,
  type ClaudrabandSession,
} from "claudraband-core";
import type { CliConfig } from "./args";

interface DaemonSession {
  session: ClaudrabandSession;
  sseClients: Set<ServerResponse>;
  pendingPermission: {
    request: ClaudrabandPermissionRequest;
    resolve: (decision: ClaudrabandPermissionDecision) => void;
  } | null;
}

interface SessionRequestBody {
  cwd?: string;
  claudeArgs?: string[];
  model?: string;
  permissionMode?: string;
  requireLive?: boolean;
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
    terminalBackend: "xterm",
    logger,
  });

  const sessions = new Map<string, DaemonSession>();

  function getSession(id: string): DaemonSession | null {
    return sessions.get(id) ?? null;
  }

  function attachEventStream(ds: DaemonSession): void {
    (async () => {
      for await (const event of ds.session.events()) {
        const data = JSON.stringify(eventToJson(event));
        for (const res of ds.sseClients) {
          res.write(`data: ${data}\n\n`);
        }
      }
    })().catch(() => {});
  }

  async function handlePermission(
    ds: DaemonSession,
    request: ClaudrabandPermissionRequest,
  ): Promise<ClaudrabandPermissionDecision> {
    return new Promise<ClaudrabandPermissionDecision>((resolve) => {
      ds.pendingPermission = { request, resolve };
      const data = JSON.stringify({
        type: "permission_request",
        ...request,
      });
      for (const res of ds.sseClients) {
        res.write(`data: ${data}\n\n`);
      }
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // POST /sessions -- create new session
      if (method === "POST" && path === "/sessions") {
        const body = JSON.parse(await readBody(req)) as SessionRequestBody;
        const sessionConfig = resolveSessionConfig(config, body);
        const session = await runtime.startSession({
          cwd: sessionConfig.cwd,
          claudeArgs: sessionConfig.claudeArgs,
          model: sessionConfig.model,
          permissionMode: sessionConfig.permissionMode as typeof config.permissionMode,
          allowTextResponses: true,
          logger,
          onPermissionRequest: (request) =>
            handlePermission(ds, request),
        });
        const ds: DaemonSession = {
          session,
          sseClients: new Set(),
          pendingPermission: null,
        };
        sessions.set(session.sessionId, ds);
        attachEventStream(ds);
        json(res, 200, { sessionId: session.sessionId });
        return;
      }

      // GET /sessions -- list active daemon sessions
      if (method === "GET" && path === "/sessions") {
        const list = [];
        for (const [id, ds] of sessions) {
          list.push({
            sessionId: id,
            alive: ds.session.isProcessAlive(),
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

      // POST /sessions/:id/resume
      if (method === "POST" && action === "resume") {
        const body = JSON.parse(await readBody(req)) as SessionRequestBody;
        const sessionConfig = resolveSessionConfig(config, body);
        const ds = getSession(sessionId);
        if (shouldReuseSession(ds)) {
          json(res, 200, { sessionId, reattached: true });
          return;
        }
        if (ds) {
          sessions.delete(sessionId);
          ds.pendingPermission?.resolve({ outcome: "cancelled" });
          ds.pendingPermission = null;
          for (const client of ds.sseClients) {
            client.end();
          }
        }
        if (body.requireLive) {
          err(res, 409, `session ${sessionId} is not live on the daemon`);
          return;
        }
        const session = await runtime.resumeSession(sessionId, {
          cwd: sessionConfig.cwd,
          claudeArgs: sessionConfig.claudeArgs,
          model: sessionConfig.model,
          permissionMode: sessionConfig.permissionMode as typeof config.permissionMode,
          allowTextResponses: true,
          logger,
          onPermissionRequest: (request) =>
            handlePermission(newDs, request),
        });
        const newDs: DaemonSession = {
          session,
          sseClients: new Set(),
          pendingPermission: null,
        };
        sessions.set(sessionId, newDs);
        attachEventStream(newDs);
        json(res, 200, { sessionId, reattached: false });
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
        const body = JSON.parse(await readBody(req)) as { text: string };
        const result = await ds.session.prompt(body.text);
        json(res, 200, result);
        return;
      }

      // POST /sessions/:id/await-turn
      if (method === "POST" && action === "await-turn") {
        const result = await ds.session.awaitTurn();
        json(res, 200, result);
        return;
      }

      // POST /sessions/:id/send
      if (method === "POST" && action === "send") {
        const body = JSON.parse(await readBody(req)) as { text: string };
        await ds.session.send(body.text);
        json(res, 200, { ok: true });
        return;
      }

      // POST /sessions/:id/interrupt
      if (method === "POST" && action === "interrupt") {
        await ds.session.interrupt();
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

      // POST /sessions/:id/detach
      if (method === "POST" && action === "detach") {
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
        const jsonlPath = sessionPath(ds.session.cwd, sessionId);
        const pendingQuestion = await hasPendingQuestion(jsonlPath);
        if (ds.pendingPermission !== null) {
          json(res, 200, { pending: true, source: "permission_request" });
          return;
        }
        const pendingNativePrompt = hasPendingNativePrompt(
          await ds.session.capturePane().catch(() => ""),
        );
        const pending = pendingQuestion || pendingNativePrompt;
        json(res, 200, {
          pending,
          source: pending ? "terminal" : "none",
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

  server.listen(config.port, () => {
    logger.info(`claudraband daemon listening on port ${config.port}`);
  });

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      logger.info("shutting down daemon");
      for (const [, ds] of sessions) {
        ds.session.detach().catch(() => {});
      }
      server.close(() => resolve());
    });
    process.on("SIGTERM", () => {
      logger.info("shutting down daemon");
      for (const [, ds] of sessions) {
        ds.session.detach().catch(() => {});
      }
      server.close(() => resolve());
    });
  });
}

export const __test = {
  resolveSessionConfig,
  shouldReuseSession,
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
