import { request as httpRequest } from "node:http";
import type {
  ClaudrabandEvent,
  ClaudrabandLogger,
  ClaudrabandPermissionDecision,
  ClaudrabandPermissionRequest,
  ClaudrabandSession,
  PermissionMode,
  PromptResult,
  ResolvedTerminalBackend,
} from "claudraband-core";
import { EventKind } from "claudraband-core";
import type { CliConfig } from "./args";
import { requestPermission } from "./client";
import type { Renderer } from "./render";
import { formatDaemonSessionList } from "./session-format";

interface DaemonSessionInfo {
  sessionId: string;
  reattached?: boolean;
  backend: ResolvedTerminalBackend;
}

interface DaemonSessionRequestBody {
  cwd: string;
  claudeArgs?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  requireLive?: boolean;
}

interface PendingQuestionResponse {
  pending: boolean;
  source: "none" | "permission_request" | "terminal";
}

function daemonUrl(server: string, path: string): string {
  const base = server.startsWith("http") ? server : `http://${server}`;
  return `${base}${path}`;
}

async function daemonPost(
  server: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return daemonRequest(server, "POST", path, body);
}

async function daemonGet(server: string, path: string): Promise<unknown> {
  return daemonRequest(server, "GET", path);
}

async function daemonDelete(server: string, path: string): Promise<unknown> {
  return daemonRequest(server, "DELETE", path);
}

async function daemonRequest(
  server: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = new URL(daemonUrl(server, path));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        ...(body !== undefined
          ? { headers: { "Content-Type": "application/json" } }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          if ((res.statusCode ?? 500) >= 400) {
            const message = typeof parsed === "object" && parsed && "error" in parsed
              ? String((parsed as { error?: unknown }).error ?? text)
              : text || `daemon request failed with status ${res.statusCode}`;
            reject(new Error(message));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function buildSessionRequestBody(
  config: CliConfig,
  options: { requireLive?: boolean } = {},
): DaemonSessionRequestBody {
  return {
    cwd: config.cwd,
    ...(config.hasExplicitClaudeArgs ? { claudeArgs: config.claudeArgs } : {}),
    ...(config.hasExplicitModel ? { model: config.model } : {}),
    ...(config.hasExplicitPermissionMode
      ? { permissionMode: config.permissionMode }
      : {}),
    ...(options.requireLive !== undefined
      ? { requireLive: options.requireLive }
      : {}),
  };
}

async function answerPendingSelection(
  session: Pick<ClaudrabandSession, "sendAndAwaitTurn">,
  optionId: string,
): Promise<PromptResult> {
  return session.sendAndAwaitTurn(optionId);
}

function connectSSE(
  server: string,
  sessionId: string,
  onEvent: (data: Record<string, unknown>) => void,
  onClose: () => void,
): { abort: () => void; ready: Promise<void> } {
  const url = new URL(daemonUrl(server, `/sessions/${sessionId}/events`));
  let readyResolved = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      readyResolved = true;
      resolve();
    };
    rejectReady = reject;
  });
  const req = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";
        for (const block of lines) {
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
              if (parsed.type === "ready") {
                resolveReady();
                continue;
              }
              onEvent(parsed);
            } catch {
              // skip malformed
            }
          }
        }
      });
      res.on("end", () => {
        if (!readyResolved) {
          rejectReady(new Error("daemon event stream closed before ready"));
        }
        onClose();
      });
    },
  );
  req.on("error", (error) => {
    if (!readyResolved) {
      rejectReady(error);
    }
    onClose();
  });
  req.end();
  return { abort: () => req.destroy(), ready };
}

class DaemonSessionProxy implements ClaudrabandSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly backend: ResolvedTerminalBackend;
  readonly model: string;
  readonly permissionMode: PermissionMode;

  private server: string;
  private eventQueue: ClaudrabandEvent[] = [];
  private eventWaiters: Array<(r: IteratorResult<ClaudrabandEvent>) => void> = [];
  private closed = false;
  private sse: { abort: () => void; ready: Promise<void> } | null = null;
  private permissionHandler?: (
    req: ClaudrabandPermissionRequest,
  ) => Promise<ClaudrabandPermissionDecision>;

  constructor(
    server: string,
    sessionId: string,
    cwd: string,
    backend: ResolvedTerminalBackend,
    model: string,
    permissionMode: PermissionMode,
    permissionHandler?: (
      req: ClaudrabandPermissionRequest,
    ) => Promise<ClaudrabandPermissionDecision>,
  ) {
    this.server = server;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.backend = backend;
    this.model = model;
    this.permissionMode = permissionMode;
    this.permissionHandler = permissionHandler;
  }

  async startEventStream(): Promise<void> {
    this.sse = connectSSE(
      this.server,
      this.sessionId,
      (data) => this.handleSSEEvent(data),
      () => this.closeEvents(),
    );
    await this.sse.ready;
  }

  private handleSSEEvent(data: Record<string, unknown>): void {
    if (data.type === "permission_request" && this.permissionHandler) {
      const request = data as unknown as ClaudrabandPermissionRequest;
      this.permissionHandler(request).then((decision) => {
        daemonPost(
          this.server,
          `/sessions/${this.sessionId}/permission`,
          decision,
        ).catch(() => {});
      });
      return;
    }

    const event: ClaudrabandEvent = {
      kind: (data.kind as EventKind) ?? EventKind.System,
      time: data.time ? new Date(data.time as string) : new Date(),
      text: (data.text as string) ?? "",
      toolName: (data.toolName as string) ?? "",
      toolID: (data.toolID as string) ?? "",
      toolInput: (data.toolInput as string) ?? "",
      role: (data.role as string) ?? "",
    };

    const waiter = this.eventWaiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.eventQueue.push(event);
    }
  }

  private closeEvents(): void {
    this.closed = true;
    for (const waiter of this.eventWaiters) {
      waiter({ value: undefined, done: true } as IteratorResult<ClaudrabandEvent>);
    }
    this.eventWaiters = [];
  }

  async *events(): AsyncGenerator<ClaudrabandEvent> {
    while (true) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<ClaudrabandEvent>>((resolve) => {
        this.eventWaiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }

  async prompt(text: string): Promise<PromptResult> {
    const result = await daemonPost(this.server, `/sessions/${this.sessionId}/prompt`, { text });
    return result as PromptResult;
  }

  async awaitTurn(): Promise<PromptResult> {
    const result = await daemonPost(this.server, `/sessions/${this.sessionId}/await-turn`);
    return result as PromptResult;
  }

  async sendAndAwaitTurn(text: string): Promise<PromptResult> {
    const result = await daemonPost(
      this.server,
      `/sessions/${this.sessionId}/send-and-await-turn`,
      { text },
    );
    return result as PromptResult;
  }

  async send(text: string): Promise<void> {
    await daemonPost(this.server, `/sessions/${this.sessionId}/send`, { text });
  }

  async interrupt(): Promise<void> {
    await daemonPost(this.server, `/sessions/${this.sessionId}/interrupt`);
  }

  async stop(): Promise<void> {
    this.sse?.abort();
    await daemonDelete(this.server, `/sessions/${this.sessionId}`);
    this.closeEvents();
  }

  async detach(): Promise<void> {
    this.sse?.abort();
    await daemonPost(this.server, `/sessions/${this.sessionId}/detach`);
    this.closeEvents();
  }

  isProcessAlive(): boolean {
    return !this.closed;
  }

  async capturePane(): Promise<string> {
    return "";
  }

  async hasPendingInput(): Promise<{ pending: boolean; source: "none" | "terminal" }> {
    const result = (await daemonGet(
      this.server,
      `/sessions/${this.sessionId}/pending-question`,
    )) as PendingQuestionResponse;
    return {
      pending: result.pending,
      source: result.source === "none" ? "none" : "terminal",
    };
  }

  async setModel(_model: string): Promise<void> {
    // Not implemented for daemon mode.
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    // Not implemented for daemon mode.
  }
}

export async function runWithDaemon(
  config: CliConfig,
  renderer: Renderer,
  _logger: ClaudrabandLogger,
): Promise<void> {
  // Handle commands that don't need a full session proxy.
  if (config.command === "sessions") {
    const result = (await daemonGet(config.server, "/sessions")) as {
      sessions: Array<{ sessionId: string; alive: boolean; hasPendingPermission: boolean }>;
    };
    if (result.sessions.length === 0) {
      process.stderr.write("no daemon sessions\n");
    } else {
      for (const line of formatDaemonSessionList(result.sessions)) {
        process.stdout.write(`${line}\n`);
      }
    }
    return;
  }

  if (config.command === "session-close") {
    if (!config.sessionId) {
        if (config.hasExplicitCwd) {
          process.stderr.write(
            "error: daemon session management does not support --cwd. Use --all or a session ID.\n",
          );
          process.exit(1);
        }
      const result = (await daemonGet(config.server, "/sessions")) as {
        sessions: Array<{ sessionId: string; alive: boolean; hasPendingPermission: boolean }>;
      };
      const liveSessions = result.sessions.filter((session) => session.alive);
      if (liveSessions.length === 0) {
        process.stderr.write("no live sessions found\n");
        return;
      }
      for (const session of liveSessions) {
        await daemonDelete(config.server, `/sessions/${session.sessionId}`);
        process.stderr.write(`session ${session.sessionId} closed\n`);
      }
      return;
    }
    await daemonDelete(config.server, `/sessions/${config.sessionId}`);
    process.stderr.write(`session ${config.sessionId} closed\n`);
    return;
  }

  const permissionHandler = (request: ClaudrabandPermissionRequest) =>
    requestPermission(renderer, {
      interactive: config.interactive,
      select: config.select,
      promptText: config.prompt,
    }, request);

  let sessionId: string;
  let sessionBackend: ResolvedTerminalBackend;

  if (config.sessionId) {
    // Resume existing session on daemon.
    const result = (await daemonPost(config.server, `/sessions/${config.sessionId}/resume`, {
      ...buildSessionRequestBody(config, { requireLive: Boolean(config.select) }),
    })) as DaemonSessionInfo;
    if (config.select && result.reattached !== true) {
      process.stderr.write(
        `error: session ${config.sessionId} is not live on the daemon. Cannot answer a pending question.\n`,
      );
      process.exit(1);
    }
    sessionId = config.sessionId;
    sessionBackend = result.backend;
  } else {
    // Create new session on daemon.
    const result = (await daemonPost(config.server, "/sessions", {
      ...buildSessionRequestBody(config),
    })) as DaemonSessionInfo;
    sessionId = result.sessionId;
    sessionBackend = result.backend;
  }

  const session = new DaemonSessionProxy(
    config.server,
    sessionId,
    config.cwd,
    sessionBackend,
    config.model,
    config.permissionMode,
    permissionHandler,
  );
  await session.startEventStream();

  // Start event pump.
  const eventPump = (async () => {
    for await (const event of session.events()) {
      renderer.handleEvent(event);
    }
  })().catch(() => {});

  if (config.debug) {
    process.stderr.write(`session: ${sessionId}\n`);
  }

  try {
    if (config.select) {
      // Validate pending question.
      const result = (await daemonGet(
        config.server,
        `/sessions/${sessionId}/pending-question`,
      )) as PendingQuestionResponse;
      if (!result.pending) {
        process.stderr.write(`error: session ${sessionId} has no pending question.\n`);
        process.exit(1);
      }
      const turnResult = result.source === "permission_request"
        ? await session.awaitTurn()
        : await answerPendingSelection(session, config.select);
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${turnResult.stopReason}\n`);
      }
    } else if (config.prompt) {
      const result = await session.prompt(config.prompt);
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${result.stopReason}\n`);
      }
    }

    if (config.interactive) {
      process.stderr.write("(interactive mode, Ctrl+C to cancel, Ctrl+D to exit)\n");
      process.stdin.setEncoding("utf8");

      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        await session.prompt(line.trim());
        renderer.ensureNewline();
      }
      rl.close();
    }

    await session.detach();
    await eventPump;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  }
}

export const __test = {
  answerPendingSelection,
  buildSessionRequestBody,
};
