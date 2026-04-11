import { stat, open } from "node:fs/promises";
import type { Event } from "../wrap/event";
import { EventKind, makeEvent } from "../wrap/event";

interface Envelope {
  type: string;
  subtype?: string;
  timestamp?: string;
  message?: unknown;
  content?: string;
  data?: unknown;
}

interface Message {
  role: string;
  content: unknown;
  stop_reason?: string | null;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

function extractToolResultText(b: ContentBlock): string {
  const raw = b.content;
  if (raw != null) {
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) {
      const parts: string[] = [];
      for (const bb of raw as { type?: string; text?: string }[]) {
        if (bb.text) parts.push(bb.text);
      }
      if (parts.length > 0) return parts.join("\n");
    }
    return JSON.stringify(raw);
  }
  return "(no output)";
}

function parseProgress(env: Envelope, ts: Date): Event | null {
  if (!env.data || typeof env.data !== "object") return null;
  const d = env.data as { type?: string; query?: string };
  let text = d.type ?? "";
  if (d.query) text += ": " + d.query;
  return makeEvent({ kind: EventKind.System, time: ts, text, role: "system" });
}

function parseMessageLineEvents(env: Envelope, ts: Date): Event[] {
  if (!env.message) return [];
  const msg = env.message as Message;
  if (!msg.content) {
    return msg.role === "assistant" && msg.stop_reason === "end_turn"
      ? [makeEvent({ kind: EventKind.TurnEnd, time: ts, role: "assistant" })]
      : [];
  }

  if (typeof msg.content === "string") {
    const kind =
      msg.role === "assistant" ? EventKind.AssistantText : EventKind.UserMessage;
    return [
      makeEvent({ kind, time: ts, text: msg.content, role: msg.role }),
      ...(msg.role === "assistant" && msg.stop_reason === "end_turn"
        ? [makeEvent({ kind: EventKind.TurnEnd, time: ts, role: "assistant" })]
        : []),
    ];
  }

  if (!Array.isArray(msg.content)) return [];
  const blocks = msg.content as ContentBlock[];

  const events: Event[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text": {
        const kind =
          msg.role === "user" ? EventKind.UserMessage : EventKind.AssistantText;
        events.push(
          makeEvent({ kind, time: ts, text: b.text ?? "", role: msg.role }),
        );
        break;
      }
      case "thinking":
        if (b.thinking) {
          events.push(
            makeEvent({
              kind: EventKind.AssistantThinking,
              time: ts,
              text: b.thinking,
              role: "assistant",
            }),
          );
        }
        break;
      case "tool_use": {
        const inp = b.input ? JSON.stringify(b.input) : "{}";
        events.push(
          makeEvent({
            kind: EventKind.ToolCall,
            time: ts,
            text: `${b.name}(${truncate(inp, 80)})`,
            toolName: b.name ?? "",
            toolID: b.id ?? "",
            toolInput: inp,
            role: "assistant",
          }),
        );
        break;
      }
      case "tool_result": {
        const text = extractToolResultText(b);
        events.push(
          makeEvent({
            kind: EventKind.ToolResult,
            time: ts,
            text: truncate(text, 200),
            toolID: b.tool_use_id ?? "",
            role: "user",
          }),
        );
        break;
      }
    }
  }
  if (msg.role === "assistant" && msg.stop_reason === "end_turn") {
    events.push(makeEvent({ kind: EventKind.TurnEnd, time: ts, role: "assistant" }));
  }
  return events;
}

export function parseLineEvents(line: string): Event[] {
  let env: Envelope;
  try {
    env = JSON.parse(line);
  } catch {
    return [];
  }

  const ts = env.timestamp ? new Date(env.timestamp) : new Date();

  switch (env.type) {
    case "user":
      return parseMessageLineEvents(env, ts);
    case "system":
      if (env.content) {
        return [
          makeEvent({
            kind: EventKind.System,
            time: ts,
            text: env.content,
            role: "system",
          }),
        ];
      }
      return [];
    case "progress": {
      const ev = parseProgress(env, ts);
      return ev ? [ev] : [];
    }
    default:
      if (env.message) {
        return parseMessageLineEvents(env, ts);
      }
      return [];
  }
}

async function readAppended(
  path: string,
  offset: number,
): Promise<{ data: string; offset: number }> {
  try {
    const fi = await stat(path);
    if (fi.size < offset) offset = 0;
    if (fi.size === offset) return { data: "", offset };

    const f = await open(path, "r");
    try {
      const buf = Buffer.alloc(fi.size - offset);
      await f.read(buf, 0, buf.length, offset);
      return { data: buf.toString(), offset: fi.size };
    } finally {
      await f.close();
    }
  } catch {
    return { data: "", offset };
  }
}

export class Tailer {
  private path: string;
  private abortController: AbortController;
  private eventQueue: Event[] = [];
  private resolvers: ((value: IteratorResult<Event>) => void)[] = [];
  private done = false;

  private startOffset: number;

  constructor(path: string, startOffset = 0) {
    this.path = path;
    this.startOffset = startOffset;
    this.abortController = new AbortController();
    this.run();
  }

  close(): void {
    this.abortController.abort();
  }

  async *events(): AsyncGenerator<Event> {
    while (true) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<Event>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }

  private pushEvent(ev: Event): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: ev, done: false });
    } else {
      this.eventQueue.push(ev);
    }
  }

  private finish(): void {
    this.done = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true } as IteratorResult<Event>);
    }
    this.resolvers = [];
  }

  private emitCompleteLines(pending: string): string {
    while (true) {
      const idx = pending.indexOf("\n");
      if (idx < 0) return pending;

      const line = pending.slice(0, idx).replace(/\r$/, "");
      pending = pending.slice(idx + 1);
      if (!line) continue;

      for (const ev of parseLineEvents(line)) {
        this.pushEvent(ev);
      }
    }
  }

  private async run(): Promise<void> {
    const signal = this.abortController.signal;

    while (!signal.aborted) {
      try {
        await stat(this.path);
        break;
      } catch {
        await sleep(250);
        if (signal.aborted) {
          this.finish();
          return;
        }
      }
    }

    let offset = this.startOffset;
    let pending = "";

    while (!signal.aborted) {
      const { data, offset: newOffset } = await readAppended(this.path, offset);
      offset = newOffset;
      if (data) {
        pending += data;
        pending = this.emitCompleteLines(pending);
      }

      await sleep(200);
    }

    this.finish();
  }
}
