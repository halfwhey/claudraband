#!/usr/bin/env node
import { openSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { parseArgs } from "./args";
import { Bridge } from "./acpbridge";

function openLogFile(): number {
  const dir = "/tmp/claudraband";
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const name = now.toISOString().replace(/[T:]/g, "-").replace(/\.\d+Z$/, "");
  const path = join(dir, `${name}.log`);
  return openSync(path, "a");
}

const { model, debug, terminalBackend } = parseArgs(process.argv.slice(2));

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
    if (debug) log("DEBUG", msg, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => log("WARN", msg, ...args),
  error: (msg: string, ...args: unknown[]) => log("ERROR", msg, ...args),
};

logger.info(
  "claudraband starting",
  "transport=stdio",
  `model=${model}`,
  `terminal_backend=${terminalBackend}`,
  `pid=${process.pid}`,
);

const bridge = new Bridge(model, terminalBackend);
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

process.on("SIGINT", () => {
  logger.info("interrupted, shutting down");
  bridge.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("terminated, shutting down");
  bridge.shutdown();
  process.exit(0);
});

conn.closed.then(() => {
  logger.info("client disconnected");
  bridge.shutdown();
  process.exit(0);
}).catch(() => {
  bridge.shutdown();
  process.exit(1);
});
