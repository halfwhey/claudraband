#!/usr/bin/env node
import { openSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClaudrabandLogger,
  ClaudrabandPermissionRequest,
  PromptResult,
  ClaudrabandSession,
  SessionSummary,
} from "claudraband-core";
import {
  createClaudraband,
  EventKind,
  resolveTerminalBackend,
} from "claudraband-core";
import type { TerminalBackend } from "claudraband-core";
import { Bridge } from "./acpbridge";
import { isDangerousPermissionMode, parseArgs, type CliConfig } from "./args";
import { requestPermission } from "./client";
import { Renderer } from "./render";
import { formatLocalSessionList } from "./session-format";

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        resolve(buf.slice(0, nl).trim());
      }
    };
    const onEnd = () => {
      process.stdin.removeListener("data", onData);
      resolve(buf.trim());
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

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
  return config.command === "continue" && Boolean(config.answer);
}

async function answerPendingSelection(
  session: Pick<ClaudrabandSession, "send" | "sendAndAwaitTurn">,
  optionId: string,
  text?: string,
) : Promise<PromptResult> {
  if (optionId === "0" && text) {
    await session.sendAndAwaitTurn(optionId);
    return session.sendAndAwaitTurn(text);
  }
  if (text) {
    await session.send(optionId);
    return session.sendAndAwaitTurn(text);
  }
  return session.sendAndAwaitTurn(optionId);
}

async function resolveTrackedSession(
  config: CliConfig,
  logger: ClaudrabandLogger,
): Promise<SessionSummary | null> {
  if (!config.sessionId) {
    return null;
  }
  const runtime = createClaudraband({
    logger,
    terminalBackend: config.terminalBackend,
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
  if (config.connect) {
    return;
  }
  if (config.command !== "prompt" && config.command !== "continue") {
    return;
  }
  if (isDangerousPermissionMode(config)) {
    return;
  }

  let resolved: "tmux" | "xterm";
  try {
    resolved = resolveTerminalBackend(config.terminalBackend);
  } catch {
    resolved = "xterm";
  }

  if (resolved === "xterm") {
    process.stderr.write(
      "error: local xterm backend requires dangerous permission settings.\n"
      + "  Either:\n"
      + "    --connect <host:port>\n"
      + "    --backend tmux\n"
      + '    -c "--dangerously-skip-permissions"\n',
    );
    process.exit(1);
  }
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
): Promise<void> {
  const runtime = createClaudraband({ logger, terminalBackend });
  const session = await runtime.inspectSession(sessionId, cwd);
  if (!session) {
    process.stderr.write(`error: session ${sessionId} not found.\n`);
    process.exit(1);
  }

  const lines: string[] = [
    `session  ${session.sessionId}`,
    `source   ${session.source}`,
    `alive    ${session.alive}`,
    `backend  ${session.backend}`,
    `cwd      ${session.cwd}`,
  ];

  if (session.owner.kind === "local") {
    lines.push(`pid      ${session.owner.pid ?? "unknown"}`);
  } else {
    lines.push(`daemon   ${session.owner.serverUrl}`);
    if (session.owner.serverPid !== undefined) {
      lines.push(`pid      ${session.owner.serverPid}`);
    }
  }

  if (session.createdAt) lines.push(`created  ${new Date(session.createdAt).toLocaleString()}`);
  if (session.updatedAt) lines.push(`updated  ${new Date(session.updatedAt).toLocaleString()}`);
  if (session.title) lines.push(`title    ${session.title}`);

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

async function showLast(
  sessionId: string,
  cwd: string | undefined,
  terminalBackend: TerminalBackend,
  logger: ClaudrabandLogger,
): Promise<void> {
  const runtime = createClaudraband({ logger, terminalBackend });
  const session = await runtime.inspectSession(sessionId, cwd);
  if (!session) {
    process.stderr.write(`error: session ${sessionId} not found.\n`);
    process.exit(1);
  }

  const events = await runtime.replaySession(sessionId, session.cwd);

  // Walk backwards to find the last assistant turn's text.
  const chunks: string[] = [];
  let inLastTurn = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === EventKind.TurnEnd) {
      if (inLastTurn) break;
      inLastTurn = true;
    }
    if (ev.kind === EventKind.TurnStart && inLastTurn) break;
    if (inLastTurn && ev.kind === EventKind.AssistantText) {
      chunks.unshift(ev.text);
    }
  }

  if (chunks.length === 0) {
    process.stderr.write("no assistant message found.\n");
    process.exit(1);
  }

  process.stdout.write(chunks.join(""));
  if (!chunks[chunks.length - 1].endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function repl(
  session: ClaudrabandSession,
  renderer: Renderer,
): Promise<void> {
  process.stderr.write("(interactive mode, Ctrl+C to cancel, Ctrl+D to exit)\n");
  process.stdin.setEncoding("utf8");

  while (true) {
    process.stderr.write("\n> ");
    const line = await readLine();
    if (!line && process.stdin.readableEnded) break;
    if (!line) continue;

    try {
      await session.prompt(line);
      renderer.ensureNewline();
    } catch (err) {
      process.stderr.write(`prompt error: ${err}\n`);
    }
  }
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
    );
    return;
  }

  if (config.command === "last") {
    await showLast(
      config.sessionId,
      config.hasExplicitCwd ? config.cwd : undefined,
      config.terminalBackend,
      logger,
    );
    return;
  }

  const trackedSession = await resolveTrackedSession(config, logger);
  if (trackedSession && !config.hasExplicitCwd) {
    config.cwd = trackedSession.cwd;
  }

  if (
    trackedSession?.owner.kind === "daemon"
    && trackedSession.source === "live"
    && trackedSession.alive
    && (
      config.command === "continue"
      || config.command === "attach"
    )
  ) {
    config.connect = trackedSession.owner.serverUrl;
  }

  if (config.command === "attach" || isSelectionFlow(config)) {
    if (!trackedSession) {
      process.stderr.write(
        `error: session ${config.sessionId} is not tracked. Use 'cband continue ${config.sessionId} ...' to resume it locally.\n`,
      );
      process.exit(1);
    }
    if (trackedSession.source !== "live" || !trackedSession.alive || !trackedSession.reattachable) {
      process.stderr.write(
        `error: session ${config.sessionId} is not live. Use 'cband continue ${config.sessionId} ...' to resume it.\n`,
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
    const sessionOptions = {
      cwd: config.cwd,
      claudeArgs: config.claudeArgs,
      model: config.model,
      permissionMode: config.permissionMode,
      allowTextResponses: true,
      terminalBackend: config.terminalBackend,
      logger,
      onPermissionRequest: (request: ClaudrabandPermissionRequest) =>
        requestPermission(renderer, {
          interactive: isInteractiveCommand(config.command),
          answerChoice: config.answer,
          promptText: config.prompt,
        }, request),
    };

    session =
      config.command === "prompt"
        ? await runtime.startSession(sessionOptions)
        : await runtime.resumeSession(config.sessionId, sessionOptions);

    const eventPump = pumpEvents(session, renderer);

    if (config.command === "prompt") {
      process.stderr.write(`session: ${session.sessionId}\n`);
    } else if (config.debug) {
      process.stderr.write(`session: ${session.sessionId}\n`);
    }

    if (config.command === "prompt" || (config.command === "continue" && !config.answer)) {
      if (config.command === "continue") {
        const pendingInput = await session.hasPendingInput();
        if (pendingInput.pending) {
          await session.detach().catch(() => {});
          process.stderr.write(
            `error: session ${config.sessionId} has a pending question or permission prompt. Use 'cband continue ${config.sessionId} --select <choice> [text]'.\n`,
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
    } else if (isSelectionFlow(config)) {
      const pendingInput = await session.hasPendingInput();
      if (!pendingInput.pending) {
        await session.detach().catch(() => {});
        process.stderr.write(
          `error: session ${config.sessionId} has no pending question or permission prompt.\n`,
        );
        process.exit(1);
      }

      // Send the selection directly to the live Claude TUI.
      promptActive = true;
      sigintCount = 0;
      const result = await answerPendingSelection(
        session,
        config.answer,
        config.prompt || undefined,
      );
      promptActive = false;
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${result.stopReason}\n`);
      }
    }

    if (config.command === "attach") {
      await repl(session, renderer);
    }

    await session.detach();
    await eventPump.catch(() => {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  }
}
