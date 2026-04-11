import type { ToolKind } from "@agentclientprotocol/sdk";

export function mapToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "Read":
    case "ReadFile":
    case "read_file":
      return "read";
    case "Write":
    case "WriteFile":
    case "write_to_file":
      return "edit";
    case "Edit":
    case "EditFile":
    case "str_replace_editor":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "bash":
    case "execute_command":
      return "execute";
    case "Grep":
    case "Glob":
    case "Search":
    case "grep":
    case "search":
    case "find_file":
    case "list_files":
      return "search";
    case "WebFetch":
    case "WebSearch":
    case "web_fetch":
    case "fetch":
      return "fetch";
    case "Think":
    case "think":
      return "think";
    default:
      return "other";
  }
}

interface AskUserQuestionOption {
  label: string;
  description: string;
}

interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

interface AskUserQuestion {
  questions: AskUserQuestionItem[];
}

export function parseAskUserQuestion(rawInput: string): AskUserQuestion | null {
  try {
    const q = JSON.parse(rawInput) as AskUserQuestion;
    if (!q.questions || q.questions.length === 0) return null;
    return q;
  } catch {
    return null;
  }
}

interface ToolCallLocation {
  path: string;
  line?: number;
}

export function extractLocations(rawInput: string): ToolCallLocation[] | null {
  try {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    for (const key of ["path", "file_path", "filename"]) {
      const v = input[key];
      if (typeof v === "string" && v !== "") {
        const loc: ToolCallLocation = { path: v };
        const lineVal = input["line"];
        if (typeof lineVal === "number" && lineVal > 0) {
          loc.line = lineVal;
        }
        return [loc];
      }
    }
    return null;
  } catch {
    return null;
  }
}
