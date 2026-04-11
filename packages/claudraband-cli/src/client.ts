import { createInterface } from "node:readline/promises";
import type {
  ClaudrabandPermissionDecision,
  ClaudrabandPermissionRequest,
} from "claudraband-core";
import type { Renderer } from "./render";

export async function requestPermission(
  renderer: Renderer,
  approveAll: boolean,
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

  if (approveAll && params.options[0]) {
    process.stderr.write(`  -> auto: ${params.options[0].name}\n`);
    return {
      outcome: "selected",
      optionId: params.options[0].optionId,
    };
  }

  if (!process.stdin.isTTY) {
    process.stderr.write("  -> denied (stdin is not interactive)\n");
    return { outcome: "cancelled" };
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = (await rl.question("Select option number (Enter to cancel): ")).trim();
    if (!answer) {
      return { outcome: "cancelled" };
    }
    const selected = params.options.find((option) => option.optionId === answer);
    if (!selected) {
      process.stderr.write("  -> invalid selection, cancelling\n");
      return { outcome: "cancelled" };
    }
    return { outcome: "selected", optionId: selected.optionId };
  } finally {
    rl.close();
  }
}
