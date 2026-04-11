import { readFile } from "node:fs/promises";

interface ContentBlock {
  type: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
}

interface Message {
  role: string;
  content: unknown;
}

interface JsonlEntry {
  type: string;
  message?: Message;
}

export interface NativePermissionPrompt {
  question: string;
  options: { number: string; label: string }[];
}

/**
 * Scan a Claude Code session JSONL file for an unresolved AskUserQuestion.
 * Returns true if the last AskUserQuestion tool_use has no matching tool_result.
 */
export async function hasPendingQuestion(jsonlPath: string): Promise<boolean> {
  let data: string;
  try {
    data = await readFile(jsonlPath, "utf-8");
  } catch {
    return false;
  }

  // Track tool_use IDs for AskUserQuestion and resolved tool_result IDs.
  const pendingIds = new Set<string>();

  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }

    if (!entry.message || !Array.isArray(entry.message.content)) continue;
    const blocks = entry.message.content as ContentBlock[];

    for (const block of blocks) {
      if (
        block.type === "tool_use" &&
        block.name === "AskUserQuestion" &&
        block.id
      ) {
        pendingIds.add(block.id);
      }
      if (block.type === "tool_result" && block.tool_use_id) {
        pendingIds.delete(block.tool_use_id);
      }
    }
  }

  return pendingIds.size > 0;
}

export function parseNativePermissionPrompt(
  paneText: string,
): NativePermissionPrompt | null {
  const questionMatch = paneText.match(/(?:^|\n)\s*(Do you want to [^\n]+\?)/);
  if (!questionMatch) return null;

  const afterQuestion = paneText.slice(
    paneText.indexOf(questionMatch[1]) + questionMatch[1].length,
  );
  const optionRegex = /(?:❯\s*)?(\d+)\.\s+(.+)/g;
  const options: NativePermissionPrompt["options"] = [];

  let match: RegExpExecArray | null;
  while ((match = optionRegex.exec(afterQuestion)) !== null) {
    options.push({ number: match[1], label: match[2].trim() });
  }

  if (options.length === 0) return null;
  return { question: questionMatch[1], options };
}

export function hasPendingNativePrompt(paneText: string): boolean {
  return parseNativePermissionPrompt(paneText) !== null;
}
