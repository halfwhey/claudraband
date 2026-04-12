import { createInterface } from "node:readline/promises";
import type {
  ClaudrabandPermissionDecision,
  ClaudrabandPermissionRequest,
} from "claudraband-core";
import type { Renderer } from "./render";

export interface PermissionConfig {
  interactive: boolean;
  answerChoice: string;
  promptText: string;
}

function formatOptionLabel(
  name: string,
  kind: ClaudrabandPermissionRequest["options"][number]["kind"],
): string {
  const suffix = `(${kind})`;
  return name.trim().endsWith(suffix) ? name.trim() : `${name} (${kind})`;
}

export async function requestPermission(
  renderer: Renderer,
  config: PermissionConfig,
  params: ClaudrabandPermissionRequest,
): Promise<ClaudrabandPermissionDecision> {
  renderer.ensureNewline();

  process.stderr.write(`\x1b[33mPermission: ${params.title}\x1b[0m\n`);
  const contentBlocks =
    params.content.length === 1 && params.content[0]?.text.trim() === params.title.trim()
      ? []
      : params.content;
  for (const block of contentBlocks) {
    process.stderr.write(`${block.text}\n`);
  }

  for (const option of params.options) {
    process.stderr.write(`  ${option.optionId}. ${formatOptionLabel(option.name, option.kind)}\n`);
  }

  // Preselected answer: pick the specified option
  if (config.answerChoice) {
    const selected = params.options.find((o) => o.optionId === config.answerChoice);
    if (selected) {
      process.stderr.write(`  -> select: ${selected.name}\n`);
      if (selected.textInput && config.promptText) {
        return { outcome: "text", text: config.promptText };
      }
      return { outcome: "selected", optionId: selected.optionId };
    }
    process.stderr.write(`  -> invalid selection '${config.answerChoice}', cancelling\n`);
    return { outcome: "cancelled" };
  }

  // Non-interactive: defer. The question stays pending so the user can
  // answer it later from the CLI.
  if (!config.interactive) {
    process.stderr.write(
      "  -> deferred (use 'cband continue <id> --select <choice> [text]' to answer)\n",
    );
    return { outcome: "deferred" };
  }

  // Interactive mode: prompt the user.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Select option number (Enter to cancel): ")).trim();
    if (!answer) return { outcome: "cancelled" };

    const selected = params.options.find((o) => o.optionId === answer);
    if (!selected) {
      process.stderr.write("  -> invalid selection, cancelling\n");
      return { outcome: "cancelled" };
    }

    // "Type a response" option: prompt for the text.
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
