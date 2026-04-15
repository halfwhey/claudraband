import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  ClaudrabandEvent,
  ClaudrabandLogger,
  ClaudrabandPermissionDecision,
  ClaudrabandPermissionRequest,
  ClaudrabandSession,
  PermissionMode,
  PromptResult,
  ResolvedTerminalBackend,
  TurnDetectionMode,
} from "claudraband-core";
import { EventKind } from "claudraband-core";
import type { CliConfig } from "./args";
import { requestPermission } from "./client";
import type { Renderer } from "./render";

interface DaemonSessionInfo {
  sessionId: string;
  resumed?: boolean;
  backend: ResolvedTerminalBackend;
}

interface DaemonSessionRequestBody {
  sessionId?: string;
  cwd: string;
  claudeArgs?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  turnDetection?: TurnDetectionMode;
  requireLive?: boolean;
}

interface PendingQuestionResponse {
  pending: boolean;
  source: "none" | "permission_request" | "terminal";
}

interface DaemonPromptResult extends PromptResult {
  eventSeq?: number;
}

interface QueuedDaemonEvent {
  event: ClaudrabandEvent;
  seq: number;
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
  options: { requireLive?: boolean; sessionId?: string } = {},
): DaemonSessionRequestBody {
  return {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    cwd: config.cwd,
    ...(config.hasExplicitClaudeArgs ? { claudeArgs: config.claudeArgs } : {}),
    ...(config.hasExplicitModel ? { model: config.model } : {}),
    ...(config.hasExplicitPermissionMode
      ? { permissionMode: config.permissionMode }
      : {}),
    ...(config.hasExplicitTurnDetection
      ? { turnDetection: config.turnDetection }
      : {}),
    ...(options.requireLive !== undefined
      ? { requireLive: options.requireLive }
      : {}),
  };
}

function isSelectionFlow(config: CliConfig): boolean {
  return (
    config.command === "prompt"
    && Boolean(config.answer)
    && Boolean(config.sessionId)
  );
}

function connectSSE(
  server: string,
  sessionId: string,
  onEvent: (data: Record<string, unknown>) => void,
  onClose: () => void,
): { abort: () => void; ready: Promise<void> } {
  const url = new URL(daemonUrl(server, `/sessions/${sessionId}/watch`));
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
  private eventQueue: QueuedDaemonEvent[] = [];
  private eventWaiters: Array<(r: IteratorResult<QueuedDaemonEvent>) => void> = [];
  private closed = false;
  private sse: { abort: () => void; ready: Promise<void> } | null = null;
  private lastRenderedSeq = 0;
  private seqWaiters: Array<{ target: number; resolve: () => void }> = [];
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
    const seq = typeof data.seq === "number" ? data.seq : 0;
    if (data.type === "permission_request" && this.permissionHandler) {
      const request = data as unknown as ClaudrabandPermissionRequest;
      this.permissionHandler(request).then((decision) => {
        daemonPost(
          this.server,
          `/sessions/${this.sessionId}/permission`,
          decision,
        ).catch(() => {});
      });
      if (seq > 0) {
        this.lastRenderedSeq = Math.max(this.lastRenderedSeq, seq);
        this.resolveSeqWaiters();
      }
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
    const queued: QueuedDaemonEvent = {
      event,
      seq,
    };

    const waiter = this.eventWaiters.shift();
    if (waiter) {
      waiter({ value: queued, done: false });
    } else {
      this.eventQueue.push(queued);
    }
  }

  private closeEvents(): void {
    this.closed = true;
    for (const waiter of this.eventWaiters) {
      waiter({ value: undefined, done: true } as IteratorResult<QueuedDaemonEvent>);
    }
    this.eventWaiters = [];
  }

  async *events(): AsyncGenerator<ClaudrabandEvent> {
    while (true) {
      if (this.eventQueue.length > 0) {
        const queued = this.eventQueue.shift()!;
        yield queued.event;
        this.markRendered(queued.seq);
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<QueuedDaemonEvent>>((resolve) => {
        this.eventWaiters.push(resolve);
      });
      if (result.done) return;
      yield result.value.event;
      this.markRendered(result.value.seq);
    }
  }

  async prompt(text: string): Promise<PromptResult> {
    const result = await daemonPost(this.server, `/sessions/${this.sessionId}/prompt`, { text });
    return result as DaemonPromptResult;
  }

  async send(text: string): Promise<void> {
    await daemonPost(this.server, `/sessions/${this.sessionId}/send`, { text });
  }

  async answerPending(choice: string, text?: string): Promise<PromptResult> {
    // Mirror the CLI: pending-question answers go through /prompt with a
    // `select` field. The daemon dispatches to `session.answerPending`.
    const result = await daemonPost(
      this.server,
      `/sessions/${this.sessionId}/prompt`,
      text !== undefined ? { select: choice, text } : { select: choice },
    );
    return result as DaemonPromptResult;
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

  async flushEvents(): Promise<void> {}

  async waitForRenderedSeq(target: number | undefined): Promise<void> {
    if (!target || target <= this.lastRenderedSeq) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.seqWaiters.push({ target, resolve });
      this.resolveSeqWaiters();
    });
  }

  private markRendered(seq: number): void {
    if (seq > 0) {
      this.lastRenderedSeq = Math.max(this.lastRenderedSeq, seq);
      this.resolveSeqWaiters();
    }
  }

  private resolveSeqWaiters(): void {
    const ready = this.seqWaiters.filter((waiter) => waiter.target <= this.lastRenderedSeq);
    this.seqWaiters = this.seqWaiters.filter((waiter) => waiter.target > this.lastRenderedSeq);
    for (const waiter of ready) {
      waiter.resolve();
    }
  }
}

export async function runWithDaemon(
  config: CliConfig,
  renderer: Renderer,
  _logger: ClaudrabandLogger,
): Promise<void> {
  const permissionHandler = (request: ClaudrabandPermissionRequest) =>
    requestPermission(renderer, {
      interactive: config.command === "attach",
      answerChoice: config.answer,
      promptText: config.prompt,
    }, request);

  let sessionId: string;
  let sessionBackend: ResolvedTerminalBackend;

  if (config.sessionId) {
    // Resume existing session (or reattach if already live on the daemon).
    const result = (await daemonPost(config.connect, "/sessions", {
      ...buildSessionRequestBody(config, { sessionId: config.sessionId }),
    })) as DaemonSessionInfo;
    if (isSelectionFlow(config) && result.resumed !== true) {
      process.stderr.write(
        `error: session ${config.sessionId} is not live on the daemon. Cannot use --select on a pending question.\n`,
      );
      process.exit(1);
    }
    sessionId = result.sessionId;
    sessionBackend = result.backend;
  } else {
    // Create new session on daemon.
    const newId = randomUUID();
    process.stderr.write(`session: ${newId}\n`);
    const result = (await daemonPost(config.connect, "/sessions", {
      ...buildSessionRequestBody(config, { sessionId: newId }),
    })) as DaemonSessionInfo;
    sessionId = result.sessionId;
    sessionBackend = result.backend;
  }

  const session = new DaemonSessionProxy(
    config.connect,
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

  if (config.command !== "prompt" && config.debug) {
    process.stderr.write(`session: ${sessionId}\n`);
  }

  try {
    if (isSelectionFlow(config)) {
      // Validate pending question.
      const result = (await daemonGet(
        config.connect,
        `/sessions/${sessionId}/pending-question`,
      )) as PendingQuestionResponse;
      if (!result.pending) {
        process.stderr.write(`error: session ${sessionId} has no pending question.\n`);
        process.exit(1);
      }
      const turnResult = await session.answerPending(
        config.answer,
        config.prompt || undefined,
      );
      await session.waitForRenderedSeq((turnResult as DaemonPromptResult).eventSeq);
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${turnResult.stopReason}\n`);
      }
    } else if (config.command === "prompt") {
      if (config.sessionId) {
        const pending = (await daemonGet(
          config.connect,
          `/sessions/${sessionId}/pending-question`,
        )) as PendingQuestionResponse;
        if (pending.pending) {
          process.stderr.write(
            `error: session ${sessionId} has a pending question or permission prompt. Use 'cband prompt --session ${sessionId} --select <choice> [text]'.\n`,
          );
          process.exit(1);
        }
      }
      const result = await session.prompt(config.prompt);
      await session.waitForRenderedSeq((result as DaemonPromptResult).eventSeq);
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${result.stopReason}\n`);
      }
    } else if (config.command === "send") {
      if (config.answer) {
        await session.send(config.answer);
      }
      if (config.prompt) {
        await session.send(config.prompt);
      }
    }

    if (config.command === "attach") {
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

export async function runWatchWithDaemon(
  server: string,
  sessionId: string,
  pretty: boolean,
  follow: boolean,
): Promise<void> {
  let exitOnNextTurnEnd = !follow;
  const sawTurnEnd = { done: false };
  await new Promise<void>((resolve, reject) => {
    const { abort, ready } = connectSSE(
      server,
      sessionId,
      (data) => {
        if (data.type === "ready") return;
        if (data.type === "permission_request") {
          // Render permission request as its own kind so watchers see it.
          writeSseEvent(data, pretty);
          return;
        }
        writeSseEvent(data, pretty);
        if (exitOnNextTurnEnd && data.kind === "turn_end") {
          sawTurnEnd.done = true;
          abort();
          resolve();
        }
      },
      () => {
        if (!sawTurnEnd.done) resolve();
      },
    );
    ready.catch((err) => {
      abort();
      reject(err);
    });
    process.on("SIGINT", () => {
      exitOnNextTurnEnd = false;
      abort();
      resolve();
    });
  });
}

function writeSseEvent(data: Record<string, unknown>, pretty: boolean): void {
  if (pretty) {
    const kind = String(data.kind ?? data.type ?? "?");
    const text = data.text ? String(data.text).replace(/\n/g, "\\n") : "";
    const time = data.time ? String(data.time) : new Date().toISOString();
    process.stdout.write(`${time} ${kind} ${text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export async function runInterruptWithDaemon(
  server: string,
  sessionId: string,
): Promise<void> {
  await daemonPost(server, `/sessions/${sessionId}/interrupt`);
}

export const __test = {
  buildSessionRequestBody,
};
