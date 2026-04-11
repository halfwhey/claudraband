import { createInterface } from "node:readline/promises";
import type {
  ClaudrabandPermissionDecision,
  ClaudrabandPermissionRequest,
} from "claudraband-core";
import type { Renderer } from "./render";

export interface PermissionConfig {
  approveAll: boolean;
  interactive: boolean;
  select: string;
  promptText: string;
}

export async function requestPermission(
  renderer: Renderer,
  config: PermissionConfig,
  params: ClaudrabandPermissionRequest,
): Promise<ClaudrabandPermissionDecision> {
  renderer.ensureNewline();

  process.stderr.write(`\x1b[33mPermission: ${params.title}\x1b[0m\n`);
  for (const block of params.content) {
    process.stderr.write(`${block.text}\n`);
  }

  for (const option of params.options) {
    process.stderr.write(`  ${option.optionId}. ${option.name} (${option.kind})\n`);
  }

  // --approve-all: pick the first option
  if (config.approveAll && params.options[0]) {
    process.stderr.write(`  -> auto: ${params.options[0].name}\n`);
    return { outcome: "selected", optionId: params.options[0].optionId };
  }

  // --select <n>: pick the specified option
  if (config.select) {
    const selected = params.options.find((o) => o.optionId === config.select);
    if (selected) {
      process.stderr.write(`  -> select: ${selected.name}\n`);
      if (selected.textInput && config.promptText) {
        return { outcome: "text", text: config.promptText };
      }
      return { outcome: "selected", optionId: selected.optionId };
    }
    process.stderr.write(`  -> invalid selection '${config.select}', cancelling\n`);
    return { outcome: "cancelled" };
  }

  // Non-interactive without --select or --approve-all: defer.
  // The question stays pending so the user can resume with --select later.
  if (!config.interactive) {
    process.stderr.write("  -> deferred (use --select <n> when resuming to answer)\n");
    return { outcome: "deferred" };
  }

  // Interactive mode: prompt the user
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Select option number (Enter to cancel): ")).trim();
    if (!answer) return { outcome: "cancelled" };

    const selected = params.options.find((o) => o.optionId === answer);
    if (!selected) {
      process.stderr.write("  -> invalid selection, cancelling\n");
      return { outcome: "cancelled" };
    }

    // "Type a response" option: prompt for the text
    if (selected.textInput) {
      const text = (await rl.question("Response: ")).trim();
      if (!text) return { outcome: "cancelled" };
      return { outcome: "text", text };
    }

    return { outcome: "selected", optionId: selected.optionId };
  } finally {
    rl.close();
  }
}
