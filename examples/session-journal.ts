#!/usr/bin/env bun
/**
 * session-journal.ts
 *
 * Replays a Claude Code session and prints a readable journal of what happened:
 * what the user asked, what Claude said, and which tools were used. No live
 * Claude process is started -- this reads the JSONL file directly.
 *
 * Usage:
 *   bun examples/session-journal.ts <session-id>
 *   bun examples/session-journal.ts <session-id> --cwd /path/to/project
 */
import { createClaudraband, EventKind } from "claudraband";

const sessionId = process.argv[2];
const cwdIdx = process.argv.indexOf("--cwd");
const cwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();

if (!sessionId) {
  console.error("usage: session-journal.ts <session-id> [--cwd <dir>]");
  process.exit(1);
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const runtime = createClaudraband();
let events = await runtime.replaySession(sessionId, cwd);

if (events.length === 0) {
  const summary =
    await runtime.inspectSession(sessionId, cwd) ??
    await runtime.inspectSession(sessionId);
  if (summary) {
    events = await runtime.replaySession(sessionId, summary.cwd);
  }
}

if (events.length === 0) {
  console.error(`no events found for session ${sessionId}`);
  process.exit(1);
}

let turnNumber = 0;

for (const event of events) {
  const ts = `${DIM}${event.time.toLocaleTimeString()}${RESET}`;

  switch (event.kind) {
    case EventKind.UserMessage:
      turnNumber++;
      console.log(`\n${ts} ${BOLD}${CYAN}[${turnNumber}] User:${RESET}`);
      console.log(event.text);
      break;

    case EventKind.AssistantText:
      console.log(`${ts} ${BOLD}${GREEN}Claude:${RESET}`);
      console.log(event.text);
      break;

    case EventKind.ToolCall:
      console.log(`${ts} ${YELLOW}> ${event.toolName}${RESET}`);
      break;

    case EventKind.ToolResult:
      console.log(`${ts} ${DIM}  (${event.text.length} chars)${RESET}`);
      break;

    case EventKind.Error:
      console.log(`${ts} \x1b[31m! ${event.text}${RESET}`);
      break;
  }
}

console.log(`\n${DIM}--- ${events.length} events, ${turnNumber} turns ---${RESET}`);
