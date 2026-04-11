#!/usr/bin/env bun
/**
 * code-review.ts
 *
 * Automated code review: runs `git diff` to find what changed, asks Claude to
 * review it, and prints the review to stdout. Approves all tool use so Claude
 * can read files for context.
 *
 * Usage:
 *   bun examples/code-review.ts                    # review unstaged changes
 *   bun examples/code-review.ts HEAD~3..HEAD       # review last 3 commits
 *   bun examples/code-review.ts main..feature      # review a branch
 */
import { createClaudraband, EventKind } from "claudraband";

const diffRange = process.argv[2] ?? "";
const diffCmd = diffRange ? `git diff ${diffRange}` : "git diff";

const prompt = [
  `Run \`${diffCmd}\` to see the changes, then give a concise code review.`,
  "Focus on bugs, security issues, and missed edge cases.",
  "Skip stylistic nitpicks. If everything looks good, say so briefly.",
].join(" ");

const runtime = createClaudraband({
  model: "haiku",
  permissionMode: "acceptEdits",
});

const session = await runtime.startSession({
  cwd: process.cwd(),
  onPermissionRequest: async (request) => ({
    outcome: "selected" as const,
    optionId: request.options[0].optionId,
  }),
});

// Collect the full review from events.
let review = "";

const stream = (async () => {
  for await (const event of session.events()) {
    switch (event.kind) {
      case EventKind.AssistantText:
        review += event.text;
        break;
      case EventKind.ToolCall:
        process.stderr.write(`> ${event.toolName}\n`);
        break;
    }
  }
})();

// prompt() may return early due to the 3s idle timeout when Claude pauses
// between tool calls. Loop until we see review text or hit a retry limit.
for (let attempt = 0; attempt < 5; attempt++) {
  await session.prompt(attempt === 0 ? prompt : "continue");
  if (review.length > 0) break;
}

process.stdout.write(review || "(no review produced)");
process.stdout.write("\n");

await session.stop();
await stream.catch(() => {});
