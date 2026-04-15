#!/usr/bin/env bun
/**
 * multi-session.ts
 *
 * Runs two Claude sessions in parallel on different tasks, streams both to
 * stdout with color-coded prefixes, then stops both.
 *
 * Usage:
 *   bun examples/multi-session.ts
 */
import {
  createClaudraband,
  EventKind,
  type ClaudrabandSession,
} from "claudraband";

const runtime = createClaudraband({
  model: "haiku",
  permissionMode: "acceptEdits",
});

const cwd = process.cwd();

function streamSession(
  session: ClaudrabandSession,
  color: string,
  label: string,
): Promise<void> {
  return (async () => {
    for await (const event of session.events()) {
      if (event.kind === EventKind.AssistantText) {
        for (const line of event.text.split("\n")) {
          if (line)
            process.stdout.write(`${color}[${label}]${RESET} ${line}\n`);
        }
      }
    }
  })();
}

const RESET = "\x1b[0m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

const approve = async (request: { options: Array<{ optionId: string }> }) => ({
  outcome: "selected" as const,
  optionId: request.options[0].optionId,
});

console.log("Starting two sessions in parallel...\n");

const [a, b] = await Promise.all([
  runtime.openSession({ cwd, onPermissionRequest: approve }),
  runtime.openSession({ cwd, onPermissionRequest: approve }),
]);

const streamA = streamSession(a, BLUE, "A");
const streamB = streamSession(b, MAGENTA, "B");

const [resultA, resultB] = await Promise.all([
  a.prompt(
    "List the top-level files in this directory and describe the project in one sentence.",
  ),
  b.prompt(
    "What language is this project written in and what testing framework does it use?",
  ),
]);

console.log(`\n--- A: ${resultA.stopReason}, B: ${resultB.stopReason} ---`);

await Promise.all([a.stop(), b.stop()]);
await Promise.all([streamA, streamB]);
