#!/usr/bin/env node
import { openSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClaudrabandLogger,
  ClaudrabandPermissionRequest,
  ClaudrabandSession,
} from "claudraband-core";
import { createClaudraband } from "claudraband-core";
import { Bridge } from "./acpbridge";
import { parseArgs } from "./args";
import { requestPermission } from "./client";
import { Renderer } from "./render";

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

async function pumpEvents(
  session: ClaudrabandSession,
  renderer: Renderer,
): Promise<void> {
  for await (const event of session.events()) {
    renderer.handleEvent(event);
  }
}

async function listSessions(cwd: string, logger: ClaudrabandLogger): Promise<void> {
  const runtime = createClaudraband({ logger });
  const sessions = await runtime.listSessions(cwd);
  if (sessions.length === 0) {
    process.stderr.write("no sessions found\n");
    return;
  }
  for (const session of sessions) {
    const date = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "";
    process.stdout.write(`${session.sessionId}  ${date}  ${session.title ?? "(untitled)"}\n`);
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

  if (config.command === "acp") {
    await runAcpServer(config);
    return;
  }

  const renderer = new Renderer();
  const logger = makeLogger(config.debug);

  if (config.command === "sessions") {
    await listSessions(config.cwd, logger);
    return;
  }

  const runtime = createClaudraband({
    claudeArgs: config.claudeArgs,
    logger,
    model: config.model,
    permissionMode: config.permissionMode,
    terminalBackend: config.terminalBackend,
  });

  let session: ClaudrabandSession | null = null;
  let promptActive = false;

  process.on("SIGINT", async () => {
    if (!session) {
      process.exit(0);
    }
    if (promptActive) {
      await session.interrupt().catch(() => {});
      promptActive = false;
    } else {
      await session.stop().catch(() => {});
      process.exit(0);
    }
  });

  try {
    const sessionOptions = {
      cwd: config.cwd,
      claudeArgs: config.claudeArgs,
      model: config.model,
      permissionMode: config.permissionMode,
      terminalBackend: config.terminalBackend,
      allowTextResponses: true,
      logger,
      onPermissionRequest: (request: ClaudrabandPermissionRequest) =>
        requestPermission(renderer, {
          approveAll: config.approveAll,
          interactive: config.interactive,
          select: config.select,
          promptText: config.prompt,
        }, request),
    };

    session = config.command === "resume"
      ? await runtime.resumeSession(config.sessionId, sessionOptions)
      : await runtime.startSession(sessionOptions);

    const eventPump = pumpEvents(session, renderer);

    if (config.debug) {
      process.stderr.write(`session: ${session.sessionId}\n`);
    }

    if (config.prompt) {
      promptActive = true;
      const result = await session.prompt(config.prompt);
      promptActive = false;
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${result.stopReason}\n`);
      }
    } else if (config.select) {
      // --select without a prompt: drain the pending turn to handle
      // any waiting question/permission.
      promptActive = true;
      const result = await session.awaitTurn();
      promptActive = false;
      renderer.ensureNewline();
      if (config.debug) {
        process.stderr.write(`stop: ${result.stopReason}\n`);
      }
    }

    if (config.interactive) {
      await repl(session, renderer);
    }

    await session.stop();
    await eventPump.catch(() => {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  }
}
