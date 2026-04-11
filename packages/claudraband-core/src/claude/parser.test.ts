import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tailer, parseLineEvents } from "./parser";
import { EventKind } from "../wrap/event";

describe("parser", () => {
  test("parseLineEvents handles user message", () => {
    const events = parseLineEvents(
      `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe(EventKind.UserMessage);
    expect(events[0].text).toBe("hello");
  });

  test("parseLineEvents handles assistant text", () => {
    const events = parseLineEvents(
      `{"type":"","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}]}}`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe(EventKind.AssistantText);
    expect(events[0].text).toBe("Hi there!");
  });

  test("parseLineEvents emits turn end for assistant end_turn messages", () => {
    const events = parseLineEvents(
      `{"type":"","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}],"stop_reason":"end_turn"}}`,
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe(EventKind.AssistantText);
    expect(events[1].kind).toBe(EventKind.TurnEnd);
  });

  test("parseLineEvents handles tool use", () => {
    const events = parseLineEvents(
      `{"type":"","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/tmp/x"}}]}}`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe(EventKind.ToolCall);
    expect(events[0].toolName).toBe("Read");
  });

  test("parseLineEvents handles multiple content blocks", () => {
    const events = parseLineEvents(
      `{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/tmp/x"}},{"type":"text","text":"done"}]}}`,
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe(EventKind.ToolCall);
    expect(events[0].toolName).toBe("Read");
    expect(events[1].kind).toBe(EventKind.AssistantText);
    expect(events[1].text).toBe("done");
  });

  test("parseLineEvents returns empty for invalid JSON", () => {
    const events = parseLineEvents("not json");
    expect(events).toHaveLength(0);
  });
});

describe("Tailer", () => {
  test("reads existing lines", async () => {
    const dir = join(tmpdir(), `claudraband-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "test.jsonl");

    const lines = [
      `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}`,
      `{"type":"","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}]}}`,
      `{"type":"","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/tmp/x"}}]}}`,
    ];
    writeFileSync(path, lines.join("\n") + "\n");

    const tl = new Tailer(path);
    try {
      const got: import("../wrap/event").Event[] = [];
      const timeout = setTimeout(() => {
        tl.close();
      }, 3000);

      for await (const ev of tl.events()) {
        got.push(ev);
        if (got.length >= 3) break;
      }
      clearTimeout(timeout);

      expect(got[0].kind).toBe(EventKind.UserMessage);
      expect(got[0].text).toBe("hello");
      expect(got[1].kind).toBe(EventKind.AssistantText);
      expect(got[2].kind).toBe(EventKind.ToolCall);
      expect(got[2].toolName).toBe("Read");
    } finally {
      tl.close();
    }
  });

  test("waits for file to appear", async () => {
    const dir = join(tmpdir(), `claudraband-test-wait-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "delayed.jsonl");

    const tl = new Tailer(path);
    try {
      setTimeout(() => {
        writeFileSync(
          path,
          `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"delayed msg"}}\n`,
        );
      }, 500);

      const timeout = setTimeout(() => {
        tl.close();
      }, 3000);

      for await (const ev of tl.events()) {
        expect(ev.kind).toBe(EventKind.UserMessage);
        expect(ev.text).toBe("delayed msg");
        break;
      }
      clearTimeout(timeout);
    } finally {
      tl.close();
    }
  });

  test("reads appended lines", async () => {
    const dir = join(tmpdir(), `claudraband-test-append-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "append.jsonl");

    writeFileSync(
      path,
      `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}\n`,
    );

    const tl = new Tailer(path);
    try {
      const timeout = setTimeout(() => {
        tl.close();
      }, 3000);

      for await (const ev of tl.events()) {
        expect(ev.kind).toBe(EventKind.UserMessage);
        expect(ev.text).toBe("hello");
        break;
      }
      clearTimeout(timeout);

      appendFileSync(
        path,
        `{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"appended reply"}]}}\n`,
      );

      const timeout2 = setTimeout(() => {
        tl.close();
      }, 3000);

      for await (const ev of tl.events()) {
        expect(ev.kind).toBe(EventKind.AssistantText);
        expect(ev.text).toBe("appended reply");
        break;
      }
      clearTimeout(timeout2);
    } finally {
      tl.close();
    }
  });

  test("emits multiple content blocks", async () => {
    const dir = join(tmpdir(), `claudraband-test-multi-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "multi.jsonl");

    writeFileSync(
      path,
      `{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/tmp/x"}},{"type":"text","text":"done"}]}}\n`,
    );

    const tl = new Tailer(path);
    try {
      const got: import("../wrap/event").Event[] = [];
      const timeout = setTimeout(() => {
        tl.close();
      }, 3000);

      for await (const ev of tl.events()) {
        got.push(ev);
        if (got.length >= 2) break;
      }
      clearTimeout(timeout);

      expect(got[0].kind).toBe(EventKind.ToolCall);
      expect(got[0].toolName).toBe("Read");
      expect(got[1].kind).toBe(EventKind.AssistantText);
      expect(got[1].text).toBe("done");
    } finally {
      tl.close();
    }
  });
});
