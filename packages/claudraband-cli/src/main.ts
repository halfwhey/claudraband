#!/usr/bin/env node
import { openSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  Claudraband,
  ClaudrabandEvent,
  ClaudrabandLogger,
  InternalClaudrabandSession,
  ClaudrabandPermissionRequest,
  ClaudrabandSession,
  SessionSummary,
} from "claudraband-core";
import {
  countTranscriptLocations,
  createClaudraband,
  EventKind,
  interruptLiveProcess,
  recordInterruptEvent,
  trackSessionStatus,
} from "claudraband-core";
import type { TerminalBackend } from "claudraband-core";
import { Bridge } from "./acpbridge";
import { extractAttachTurnText } from "./attach-output";
import { parseArgs, type CliConfig } from "./args";
import { requestPermission } from "./client";
import { streamInputLines } from "./input-lines";
import { autoDecisionForPermissionMode } from "./permissions";
import { Renderer } from "./render";
import { formatLocalSessionList } from "./session-format";
import { replayAndFollowEvents } from "./watch-events";

function makeLogger(debug: boolean): ClaudrabandLogger {
  if (!debug) {
    const noop = () => {};
    return {
      info: noop,
      debug: noop,
      warn: noop,
      error: noop,
    };
  }

  return {
    info: (msg, ...args) => process.stderr.write(`info: ${msg} ${args.join(" ")}\n`),
    debug: (msg, ...args) => process.stderr.write(`debug: ${msg} ${args.join(" ")}\n`),
    warn: (msg, ...args) => process.stderr.write(`warn: ${msg} ${args.join(" ")}\n`),
    error: (msg, ...args) => process.stderr.write(`error: ${msg} ${args.join(" ")}\n`),
  };
}

function openLogFile(): number {
  const dir = "/tmp/claudraband";
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const name = now.toISOString().replace(/[T:]/g, "-").replace(/\.\d+Z$/, "");
  const path = join(dir, `${name}.log`);
  return openSync(path, "a");
}

async function runAcpServer(config: ReturnType<typeof parseArgs>): Promise<void> {
  const logFd = openLogFile();

  function log(level: string, msg: string, ...args: unknown[]): void {
    const ts = new Date().toISOString();
    const line = `${ts} ${level} ${msg}${args.length ? " " + args.join(" ") : ""}\n`;
    process.stderr.write(line);
    writeFileSync(logFd, line);
  }

  const logger = {
    info: (msg: string, ...args: unknown[]) => log("INFO", msg, ...args),
    debug: (msg: string, ...args: unknown[]) => {
      if (config.debug) log("DEBUG", msg, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => log("WARN", msg, ...args),
    error: (msg: string, ...args: unknown[]) => log("ERROR", msg, ...args),
  };

  logger.info(
    "claudraband starting",
    "transport=stdio",
    "mode=acp",
    `model=${config.model}`,
    `claude_args=${JSON.stringify(config.claudeArgs)}`,
    `terminal_backend=${config.terminalBackend}`,
    `pid=${process.pid}`,
  );

  const bridge = new Bridge({
    claudeArgs: config.claudeArgs,
    model: config.model,
    permissionMode: config.permissionMode,
    terminalBackend: config.terminalBackend,
    turnDetection: config.turnDetection,
  });
  bridge.setLogger(logger);

  const input = new WritableStream({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (data: Buffer) => {
        controller.enqueue(new Uint8Array(data));
      });
      process.stdin.on("end", () => {
        controller.close();
      });
    },
  });

  const stream = acp.ndJsonStream(input, output);
  const conn = new acp.AgentSideConnection((_conn) => bridge, stream);
  bridge.setConnection(conn);

  logger.info("acp server ready", "protocol=ACP/1", "waiting=client initialize");

  const shutdown = (exitCode: number) => {
    bridge.shutdown();
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    logger.info("interrupted, shutting down");
    shutdown(0);
  });

  process.on("SIGTERM", () => {
    logger.info("terminated, shutting down");
    shutdown(0);
  });

  await conn.closed.then(() => {
    logger.info("client disconnected");
    shutdown(0);
  }).catch(() => {
    shutdown(1);
  });
}

function isInteractiveCommand(command: CliConfig["command"]): boolean {
  return command === "attach";
}

function isSelectionFlow(config: CliConfig): boolean {
  return (
    config.command === "prompt"
    && Boolean(config.sessionId)
    && Boolean(config.answer)
  );
}

async function resolveTrackedSession(
  config: CliConfig,
  logger: ClaudrabandLogger,
): Promise<SessionSummary | null> {
  if (!config.sessionId) {
    return null;
  }
  if (!config.hasExplicitCwd && await countTranscriptLocations(config.sessionId) > 1) {
    process.stderr.write(
      `error: session ${config.sessionId} matched multiple transcript locations. Re-run with --cwd <dir>.\n`,
    );
    process.exit(1);
  }
  const runtime = createClaudraband({
    logger,
    terminalBackend: config.terminalBackend,
    turnDetection: config.turnDetection,
  });
  const sessions = await runtime.listSessions(
    config.hasExplicitCwd ? config.cwd : undefined,
  );
  const matches = sessions.filter((session) => session.sessionId === config.sessionId);
  if (matches.length > 1 && !config.hasExplicitCwd) {
    process.stderr.write(
      `error: session ${config.sessionId} matched multiple transcript locations. Re-run with --cwd <dir>.\n`,
    );
    process.exit(1);
  }
  return matches[0] ?? null;
}

function validateLocalLaunchPermissions(config: CliConfig): void {
  const isLocalXterm =
    config.terminalBackend === "xterm"
    && !config.connect
    && config.command !== "serve";
  if (!isLocalXterm) {
    return;
  }

  const hasDangerousFlag =
    config.permissionMode === "bypassPermissions"
    || config.claudeArgs.includes("--dangerously-skip-permissions");
  if (hasDangerousFlag) {
    return;
  }

  process.stderr.write(
    "error: local xterm backend requires dangerous permission settings. Re-run with `-c '--dangerously-skip-permissions'` or `--permission-mode bypassPermissions`.\n",
  );
  process.exit(1);
}

async function pumpEvents(
  session: ClaudrabandSession,
  renderer: Renderer,
): Promise<void> {
  for await (const event of session.events()) {
    renderer.handleEvent(event);
  }
}

async function listSessions(
  cwd: string | undefined,
  terminalBackend: "auto" | "tmux" | "xterm",
  logger: ClaudrabandLogger,
): Promise<void> {
  const runtime = createClaudraband({ logger, terminalBackend });
  const sessions = (await runtime.listSessions(cwd))
    .filter((session) => session.source === "live" && session.alive);
  if (sessions.length === 0) {
    process.stderr.write("no sessions found\n");
    return;
  }
  for (const line of formatLocalSessionList(sessions)) {
    process.stdout.write(`${line}\n`);
  }
}

async function closeLocalSessions(
  cwd: string | undefined,
  terminalBackend: "auto" | "tmux" | "xterm",
  logger: ClaudrabandLogger,
  sessionId: string,
  closeAll: boolean,
): Promise<void> {
  const runtime = createClaudraband({ logger, terminalBackend });

  if (sessionId) {
    const closed = await runtime.closeSession(sessionId);
    if (!closed) {
      process.stderr.write(`error: session ${sessionId} is not live.\n`);
      process.exit(1);
    }
    process.stderr.write(`session ${sessionId} closed\n`);
    return;
  }

  const sessions = await runtime.listSessions(cwd);
  const liveSessions = sessions.filter((session) => session.source === "live" && session.alive);

  if (liveSessions.length === 0) {
    process.stderr.write("no live sessions found\n");
    return;
  }

  for (const session of liveSessions) {
    if (!closeAll && cwd === undefined) {
      continue;
    }
    if (await runtime.closeSession(session.sessionId)) {
      process.stderr.write(`session ${session.sessionId} closed\n`);
    }
  }
}

async function showStatus(
  sessionId: string,
  cwd: string | undefined,
  terminalBackend: TerminalBackend,
  logger: ClaudrabandLogger,
  asJson: boolean,
): Promise<void> {
  if (!cwd && await countTranscriptLocations(sessionId) > 1) {
    process.stderr.write(
      `error: session ${sessionId} matched multiple transcript locations. Re-run with --cwd <dir>.\n`,
    );
    process.exit(1);
  }
  const runtime = createClaudraband({ logger, terminalBackend });
  const status = await runtime.getStatus(sessionId, cwd);
  if (!status) {
    process.stderr.write(`error: session ${sessionId} not found.\n`);
    process.exit(1);
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  const lines: string[] = [
    `session           ${status.sessionId}`,
    `source            ${status.source}`,
    `alive             ${status.alive}`,
    `backend           ${status.backend}`,
    `cwd               ${status.cwd}`,
    `turnInProgress    ${status.turnInProgress}`,
    `pendingInput      ${status.pendingInput}`,
  ];

  if (status.owner.kind === "local") {
    lines.push(`pid               ${status.owner.pid ?? "unknown"}`);
  } else {
    lines.push(`daemon            ${status.owner.serverUrl}`);
    if (status.owner.serverPid !== undefined) {
      lines.push(`pid               ${status.owner.serverPid}`);
    }
  }

  if (status.createdAt) lines.push(`created           ${new Date(status.createdAt).toLocaleString()}`);
  if (status.updatedAt) lines.push(`updated           ${new Date(status.updatedAt).toLocaleString()}`);
  if (status.title) lines.push(`title             ${status.title}`);

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

async function showLast(
  sessionId: string,
  cwd: string | undefined,
  terminalBackend: TerminalBackend,
  logger: ClaudrabandLogger,
  asJson: boolean,
): Promise<void> {
  if (!cwd && await countTranscriptLocations(sessionId) > 1) {
    process.stderr.write(
      `error: session ${sessionId} matched multiple transcript locations. Re-run with --cwd <dir>.\n`,
    );
    process.exit(1);
  }
  const runtime = createClaudraband({ logger, terminalBackend });
  const summary = await runtime.inspectSession(sessionId, cwd);
  if (!summary) {
    process.stderr.write(`error: session ${sessionId} not found.\n`);
    process.exit(1);
  }

  const text = await runtime.getLastMessage(sessionId, summary.cwd);

  if (text === null) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ sessionId, cwd: summary.cwd, text: null })}\n`);
    }
    process.exit(1);
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ sessionId, cwd: summary.cwd, text })}\n`);
    return;
  }

  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function runWatch(
  sessionId: string,
  cwd: string | undefined,
  terminalBackend: TerminalBackend,
  logger: ClaudrabandLogger,
  pretty: boolean,
  follow: boolean,
  connect: string,
): Promise<void> {
  if (connect) {
    const { runWatchWithDaemon } = await import("./daemon-client");
    await runWatchWithDaemon(connect, sessionId, pretty, follow);
    return;
  }

  const runtime = createClaudraband({ logger, terminalBackend });
  const summary = await runtime.inspectSession(sessionId, cwd);
  if (!summary) {
    process.stderr.write(`error: session ${sessionId} not found.\n`);
    process.exit(1);
  }

  if (summary.owner.kind === "daemon") {
    const { runWatchWithDaemon } = await import("./daemon-client");
    await runWatchWithDaemon(summary.owner.serverUrl, sessionId, pretty, follow);
    return;
  }

  let session: ClaudrabandSession | null = null;
  let liveEvents: AsyncIterable<ClaudrabandEvent> | undefined;
  if (summary.alive && summary.reattachable) {
    session = await runtime.openSession({
      sessionId,
      cwd: summary.cwd,
      terminalBackend,
      logger,
    });
    liveEvents = session.events();
  }

  const replayed = await runtime.replaySession(sessionId, summary.cwd);
  if (!session) {
    for (const ev of replayed) {
      writeWatchEvent(ev, pretty);
    }
    return;
  }

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    void session.detach().catch(() => {});
  };
  process.once("SIGINT", onSigint);
  try {
    for await (const frame of replayAndFollowEvents(replayed, liveEvents)) {
      writeWatchEvent(frame.event, pretty);
      if (!follow && frame.source === "live" && frame.event.kind === EventKind.TurnEnd) {
        break;
      }
      if (interrupted) {
        break;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    await session.detach().catch(() => {});
  }
}

function writeWatchEvent(ev: ClaudrabandEvent, pretty: boolean): void {
  if (pretty) {
    const tag = ev.kind;
    const body = ev.text ? ev.text.replace(/\n/g, "\\n") : "";
    process.stdout.write(`${ev.time.toISOString()} ${tag} ${body}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    kind: ev.kind,
    time: ev.time.toISOString(),
    text: ev.text || undefined,
    toolName: ev.toolName || undefined,
    toolID: ev.toolID || undefined,
    toolInput: ev.toolInput || undefined,
    role: ev.role || undefined,
  })}\n`);
}

async function captureTurnText(
  runtime: Claudraband,
  session: ClaudrabandSession,
  sendPrompt: () => Promise<void>,
): Promise<string> {
  const before = await runtime.replaySession(session.sessionId, session.cwd);
  await sendPrompt();
  const after = await runtime.replaySession(session.sessionId, session.cwd);
  return extractAttachTurnText(before, after);
}

async function handleAttachLine(
  runtime: Claudraband,
  session: ClaudrabandSession,
  renderer: Renderer,
  line: string,
  directTurnOutput: boolean,
): Promise<void> {
  if (directTurnOutput) {
    const text = await captureTurnText(runtime, session, () => session.prompt(line).then(() => {}));
    if (text) {
      process.stdout.write(text);
      if (!text.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
    return;
  }

  await session.prompt(line);
  renderer.ensureNewline();
}

async function repl(
  runtime: Claudraband,
  session: ClaudrabandSession,
  renderer: Renderer,
  directTurnOutput = false,
): Promise<void> {
  process.stdin.setEncoding("utf8");

  if (!process.stdin.isTTY) {
    for await (const rawLine of streamInputLines(process.stdin)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        await handleAttachLine(runtime, session, renderer, line, directTurnOutput);
      } catch (err) {
        process.stderr.write(`prompt error: ${err}\n`);
      }
    }
    return;
  }

  process.stderr.write("(interactive mode, Ctrl+C to cancel, Ctrl+D to exit)\n");
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    process.stderr.write("\n> ");
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        process.stderr.write("\n> ");
        continue;
      }

      try {
        await handleAttachLine(runtime, session, renderer, trimmed, directTurnOutput);
      } catch (err) {
        process.stderr.write(`prompt error: ${err}\n`);
      }
      if (process.stdin.readableEnded) {
        break;
      }
      process.stderr.write("\n> ");
    }
  } finally {
    rl.close();
  }
}

async function runInterrupt(
  sessionId: string,
  cwd: string | undefined,
  terminalBackend: TerminalBackend,
  logger: ClaudrabandLogger,
  connect: string,
): Promise<void> {
  if (connect) {
    const { runInterruptWithDaemon } = await import("./daemon-client");
    await runInterruptWithDaemon(connect, sessionId);
    return;
  }

  const runtime = createClaudraband({ logger, terminalBackend });
  const summary = await runtime.inspectSession(sessionId, cwd);
  if (!summary) {
    process.stderr.write(`error: session ${sessionId} not found.\n`);
    process.exit(1);
  }

  if (summary.owner.kind === "daemon") {
    const { runInterruptWithDaemon } = await import("./daemon-client");
    await runInterruptWithDaemon(summary.owner.serverUrl, sessionId);
    return;
  }

  if (!summary.alive || !summary.reattachable) {
    process.stderr.write(`error: session ${sessionId} is not live.\n`);
    process.exit(1);
  }

  if (summary.backend === "tmux") {
    const interrupted = await interruptLiveProcess(sessionId);
    if (!interrupted) {
      process.stderr.write(`error: session ${sessionId} is not live.\n`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    let refreshed = await runtime.getStatus(sessionId, summary.cwd);
    if (refreshed && !refreshed.alive && refreshed.turnInProgress) {
      await recordInterruptEvent(sessionId, summary.cwd).catch(() => {});
      refreshed = await runtime.getStatus(sessionId, summary.cwd);
    }
    if (refreshed) {
      await trackSessionStatus(refreshed).catch(() => {});
    }
    return;
  }

  const session = await runtime.openSession({
    sessionId,
    cwd: summary.cwd,
    terminalBackend,
    logger,
  });
  await session.interrupt();
  await (session as InternalClaudrabandSession).awaitTurn().catch(() => {});
  await session.detach();
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseArgs(argv);
  for (const warning of config.warnings) {
    process.stderr.write(`${warning}\n`);
  }

  if (config.command === "acp") {
    await runAcpServer(config);
    return;
  }

  if (config.command === "serve") {
    const { startServer } = await import("./server");
    await startServer(config);
    return;
  }

  const renderer = new Renderer();
  const logger = makeLogger(config.debug);

  if (config.command === "sessions") {
    await listSessions(
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
    );
    return;
  }

  if (config.command === "session-close") {
    await closeLocalSessions(
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
      config.sessionId,
      config.allSessions,
    );
    return;
  }

  if (config.command === "status") {
    await showStatus(
      config.sessionId,
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
      config.json,
    );
    return;
  }

  if (config.command === "last") {
    await showLast(
      config.sessionId,
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
      config.json,
    );
    return;
  }

  if (config.command === "watch") {
    await runWatch(
      config.sessionId,
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
      config.pretty,
      config.follow,
      config.connect,
    );
    return;
  }

  if (config.command === "interrupt") {
    await runInterrupt(
      config.sessionId,
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
      config.connect,
    );
    return;
  }

  const trackedSession = await resolveTrackedSession(config, logger);
  if (trackedSession && !config.hasExplicitCwd) {
    config.cwd = trackedSession.cwd;
  }

  // If the session has a daemon owner and is live, route through that daemon.
  if (
    trackedSession?.owner.kind === "daemon"
    && trackedSession.source === "live"
    && trackedSession.alive
    && config.sessionId
  ) {
    config.connect = trackedSession.owner.serverUrl;
  }

  if (config.command === "attach" || isSelectionFlow(config)) {
    if (!trackedSession) {
      process.stderr.write(
        `error: session ${config.sessionId} is not tracked. Start a fresh session or pass --session <id> with a known session.\n`,
      );
      process.exit(1);
    }
    if (trackedSession.source !== "live" || !trackedSession.alive || !trackedSession.reattachable) {
      process.stderr.write(
        `error: session ${config.sessionId} is not live.\n`,
      );
      process.exit(1);
    }
  }

  if (
    isSelectionFlow(config)
    && trackedSession?.source === "live"
    && trackedSession.owner.kind === "local"
    && trackedSession.backend !== "tmux"
  ) {
    process.stderr.write(
      "error: --select requires a live tmux session locally or a live daemon-backed session.\n",
    );
    process.exit(1);
  }

  if (config.connect) {
    const { runWithDaemon } = await import("./daemon-client");
    await runWithDaemon(config, renderer, logger);
    return;
  }

  validateLocalLaunchPermissions(config);

  const runtime = createClaudraband({
    claudeArgs: config.claudeArgs,
    logger,
    model: config.model,
    permissionMode: config.permissionMode,
    terminalBackend: config.terminalBackend,
    turnDetection: config.turnDetection,
  });

  let session: ClaudrabandSession | null = null;
  let promptActive = false;
  let sigintCount = 0;

  process.on("SIGINT", async () => {
    sigintCount++;
    if (!session) {
      process.exit(0);
    }
    if (sigintCount >= 2) {
      // Force kill on second SIGINT.
      await session.stop().catch(() => {});
      process.exit(0);
    }
    if (promptActive) {
      await session.interrupt().catch(() => {});
      promptActive = false;
    } else {
      await session.detach().catch(() => {});
      process.exit(0);
    }
  });

  try {
    const pipedAttach = config.command === "attach" && !process.stdin.isTTY;
    const sessionOptions = {
      cwd: config.cwd,
      claudeArgs: config.claudeArgs,
      model: config.model,
      permissionMode: config.permissionMode,
      allowTextResponses: true,
      terminalBackend: config.terminalBackend,
      turnDetection: config.turnDetection,
      logger,
      onPermissionRequest: (request: ClaudrabandPermissionRequest) => {
        const autoDecision = autoDecisionForPermissionMode(
          config.permissionMode,
          request,
        );
        if (autoDecision) {
          return Promise.resolve(autoDecision);
        }
        return requestPermission(renderer, {
          interactive: isInteractiveCommand(config.command),
          answerChoice: config.answer,
          promptText: config.prompt,
        }, request);
      },
    };

    session = await runtime.openSession({
      ...sessionOptions,
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    });

    const eventPump = pipedAttach
      ? Promise.resolve()
      : pumpEvents(session, renderer);

    if (!config.sessionId) {
      process.stderr.write(`session: ${session.sessionId}\n`);
    } else if (config.debug) {
      process.stderr.write(`session: ${session.sessionId}\n`);
    }

    if (config.command === "send") {
      if (config.answer) {
        await session.send(config.answer);
      }
      if (config.prompt) {
        await session.send(config.prompt);
      }
    } else if (config.command === "prompt") {
      if (isSelectionFlow(config)) {
        const pendingInput = await session.hasPendingInput();
        if (!pendingInput.pending) {
          await session.detach().catch(() => {});
          process.stderr.write(
            `error: session ${config.sessionId} has no pending question or permission prompt.\n`,
          );
          process.exit(1);
        }
        promptActive = true;
        sigintCount = 0;
        const result = await session.answerPending(
          config.answer,
          config.prompt || undefined,
        );
        promptActive = false;
        renderer.ensureNewline();
        if (config.debug) {
          process.stderr.write(`stop: ${result.stopReason}\n`);
        }
      } else {
        if (config.sessionId) {
          const pendingInput = await session.hasPendingInput();
          if (pendingInput.pending) {
            await session.detach().catch(() => {});
            process.stderr.write(
              `error: session ${config.sessionId} has a pending question or permission prompt. Use 'cband prompt --session ${config.sessionId} --select <choice> [text]'.\n`,
            );
            process.exit(1);
          }
        }
        promptActive = true;
        sigintCount = 0;
        const result = await session.prompt(config.prompt);
        promptActive = false;
        renderer.ensureNewline();
        if (config.debug) {
          process.stderr.write(`stop: ${result.stopReason}\n`);
        }
      }
    }

    if (config.command === "attach") {
      await repl(runtime, session, renderer, pipedAttach);
    }

    if (pipedAttach) {
      void session.detach().catch(() => {});
      return;
    }

    await session.detach();
    await eventPump.catch(() => {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  }
}
