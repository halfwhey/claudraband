import type { ClaudrabandEvent } from "claudraband";
import { EventKind } from "claudraband";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export class Renderer {
  private midLine = false;

  handleEvent(event: ClaudrabandEvent): void {
    switch (event.kind) {
      case EventKind.AssistantText:
        this.writeContent(event.text);
        break;
      case EventKind.AssistantThinking:
      case EventKind.System:
        this.writeThought(event.text);
        break;
      case EventKind.ToolCall:
        this.ensureNewline();
        process.stdout.write(`${BOLD}${YELLOW}> ${event.toolName}${RESET}\n`);
        this.midLine = false;
        break;
      case EventKind.ToolResult:
        this.ensureNewline();
        process.stdout.write(`${GREEN}+ ${event.toolName || "tool"}${RESET}\n`);
        this.midLine = false;
        break;
      case EventKind.Error:
        this.ensureNewline();
        process.stdout.write(`${RED}! ${event.text}${RESET}\n`);
        this.midLine = false;
        break;
      default:
        break;
    }
  }

  private writeContent(text: string): void {
    if (!text) return;
    process.stdout.write(text);
    this.midLine = !text.endsWith("\n");
  }

  private writeThought(text: string): void {
    if (!text) return;
    process.stdout.write(`${DIM}${text}${RESET}`);
    this.midLine = !text.endsWith("\n");
  }

  ensureNewline(): void {
    if (this.midLine) {
      process.stdout.write("\n");
      this.midLine = false;
    }
  }
}
