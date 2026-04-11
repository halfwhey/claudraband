#!/usr/bin/env node
import type {
  ClaudrabandLogger,
  ClaudrabandPermissionRequest,
  ClaudrabandSession,
} from "claudraband-core";
import { createClaudraband } from "claudraband-core";
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

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const renderer = new Renderer();
  const logger = makeLogger(config.debug);

  if (config.command === "sessions") {
    await listSessions(config.cwd, logger);
    return;
  }

  const runtime = createClaudraband({
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
      model: config.model,
      permissionMode: config.permissionMode,
      terminalBackend: config.terminalBackend,
      logger,
      onPermissionRequest: (request: ClaudrabandPermissionRequest) =>
        requestPermission(renderer, config.approveAll, request),
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

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : JSON.stringify(err);
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
