import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudraband, EventKind, __test } from "./index";
import { Session } from "./tmuxctl";
import type { Event } from "./wrap/event";

function isSandboxTmuxError(err: unknown): boolean {
  return String(err).includes("Operation not permitted");
}

class FakeSessionWrapper {
  private queue: Event[] = [];
  private resolvers: Array<(result: IteratorResult<Event>) => void> = [];
  private closed = false;

  name(): string {
    return "fake";
  }

  model(): string {
    return "sonnet";
  }

  async start(_signal: AbortSignal): Promise<void> {}

  async stop(): Promise<void> {
    this.finish();
  }

  async send(input: string): Promise<void> {
    if (input !== "2") {
      throw new Error(`unexpected input: ${input}`);
    }
    this.emit({
      kind: EventKind.AssistantText,
      time: new Date(),
      text: "Blue selected",
      toolName: "",
      toolID: "",
      toolInput: "",
      role: "assistant",
    });
    this.finish();
  }

  async interrupt(): Promise<void> {}

  alive(): boolean {
    return !this.closed;
  }

  async *events(): AsyncGenerator<Event> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<Event>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }

  async capturePane(): Promise<string> {
    return "";
  }

  setModel(_model: string): void {}

  setPermissionMode(_mode: string): void {}

  async restart(): Promise<void> {}

  async detach(): Promise<void> {
    this.finish();
  }

  isProcessAlive(): boolean {
    return !this.closed;
  }

  async processId(): Promise<number | undefined> {
    return 1234;
  }

  protected emit(event: Event): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  protected finish(): void {
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true } as IteratorResult<Event>);
    }
    this.resolvers = [];
  }
}

class PromptLifecycleWrapper extends FakeSessionWrapper {
  override async send(input: string): Promise<void> {
    this.emit({
      kind: EventKind.UserMessage,
      time: new Date(),
      text: input,
      toolName: "",
      toolID: "",
      toolInput: "",
      role: "user",
    });
  }
}

describe("session discovery", () => {
  let previousRegistryHome: string | undefined;
  let registryHome: string;

  beforeEach(async () => {
    previousRegistryHome = process.env.CLAUDRABAND_HOME;
    registryHome = await mkdtemp(join(tmpdir(), "claudraband-registry-"));
    process.env.CLAUDRABAND_HOME = registryHome;
  });

  afterEach(async () => {
    if (previousRegistryHome === undefined) {
      delete process.env.CLAUDRABAND_HOME;
    } else {
      process.env.CLAUDRABAND_HOME = previousRegistryHome;
    }
    await rm(registryHome, { recursive: true, force: true });
  });

  test("lists live tmux sessions before their jsonl file exists", async () => {
    const sessionId = randomUUID();
    let session: Session | undefined;

    try {
      session = await Session.newSession(
        "claudraband-working-session",
        80,
        24,
        "/tmp",
        ["bash", "-c", "sleep 5"],
        sessionId,
      );
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }

    try {
      await Bun.sleep(200);
      const sessions = await createClaudraband({
        terminalBackend: "tmux",
      }).listSessions("/tmp");
      const found = sessions.find((entry) => entry.sessionId === sessionId);
      expect(found).toBeDefined();
      expect(found?.cwd).toBe("/tmp");
      expect(found?.backend).toBe("tmux");
      expect(found?.alive).toBe(true);
      expect(found?.reattachable).toBe(true);
    } finally {
      await session?.kill().catch(() => {});
    }
  });

  test("closes live tmux sessions through the runtime", async () => {
    const sessionId = randomUUID();
    let session: Session | undefined;
    const runtime = createClaudraband({
      terminalBackend: "tmux",
    });

    try {
      session = await Session.newSession(
        "claudraband-working-session",
        80,
        24,
        "/tmp",
        ["bash", "-c", "sleep 5"],
        sessionId,
      );
    } catch (err) {
      if (isSandboxTmuxError(err)) return;
      throw err;
    }

    try {
      const closed = await runtime.closeSession(sessionId);
      expect(closed).toBe(true);
      expect((await runtime.inspectSession(sessionId, "/tmp"))?.alive).toBe(false);
    } finally {
      await session?.kill().catch(() => {});
    }
  });

  test("lists and closes daemon-owned sessions through the canonical registry", async () => {
    const sessionId = randomUUID();
    const deleted: string[] = [];
    let alive = true;
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessions: alive ? [{ sessionId, alive: true }] : [],
        }));
        return;
      }
      if (req.method === "DELETE" && req.url === `/sessions/${sessionId}`) {
        deleted.push(sessionId);
        alive = false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }

      const recordDir = join(registryHome, "sessions");
      await mkdir(recordDir, { recursive: true });
      await writeFile(
        join(recordDir, `${sessionId}.json`),
        JSON.stringify({
          version: 1,
          sessionId,
          cwd: "/repo",
          backend: "xterm",
          title: "daemon session",
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          lastKnownAlive: true,
          reattachable: true,
          owner: {
            kind: "daemon",
            serverUrl: `http://127.0.0.1:${address.port}`,
            serverPid: process.pid,
            serverInstanceId: "daemon-test",
          },
        }),
      );

      const runtime = createClaudraband();
      const sessions = await runtime.listSessions();
      const found = sessions.find((session) => session.sessionId === sessionId);
      expect(found?.owner.kind).toBe("daemon");
      expect(found?.alive).toBe(true);

      const closed = await runtime.closeSession(sessionId);
      expect(closed).toBe(true);
      expect(deleted).toEqual([sessionId]);
      expect((await runtime.inspectSession(sessionId))?.alive).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(join(registryHome, "sessions", `${sessionId}.json`), {
        force: true,
      });
    }
  });

  test("sendAndAwaitTurn arms the waiter before sending deferred selections", async () => {
    const session = __test.createSession(new FakeSessionWrapper() as never);

    const result = await session.sendAndAwaitTurn("2");

    expect(result).toEqual({ stopReason: "end_turn" });
  });

  test("sendAndAwaitTurn completes when the selection only yields a tool result", async () => {
    class ToolResultOnlyWrapper extends FakeSessionWrapper {
      override async send(input: string): Promise<void> {
        if (input !== "2") {
          throw new Error(`unexpected input: ${input}`);
        }
        this.emit({
          kind: EventKind.ToolResult,
          time: new Date(),
          text: "Blue",
          toolName: "",
          toolID: "ask-user-question-1",
          toolInput: "",
          role: "user",
        });
        this.finish();
      }
    }

    const session = __test.createSession(new ToolResultOnlyWrapper() as never);

    const result = await session.sendAndAwaitTurn("2");

    expect(result).toEqual({ stopReason: "end_turn" });
  });

  test("prompt waits for explicit turn end instead of idling out after assistant text", async () => {
    class TurnEndWrapper extends PromptLifecycleWrapper {
      override async send(input: string): Promise<void> {
        await super.send(input);
        this.emit({
          kind: EventKind.AssistantText,
          time: new Date(),
          text: "Let me check that",
          toolName: "",
          toolID: "",
          toolInput: "",
          role: "assistant",
        });
        setTimeout(() => {
          this.emit({
            kind: EventKind.ToolCall,
            time: new Date(),
            text: "Read({})",
            toolName: "Read",
            toolID: "tool-1",
            toolInput: "{}",
            role: "assistant",
          });
          this.emit({
            kind: EventKind.ToolResult,
            time: new Date(),
            text: "done",
            toolName: "",
            toolID: "tool-1",
            toolInput: "",
            role: "user",
          });
          this.emit({
            kind: EventKind.AssistantText,
            time: new Date(),
            text: "Finished",
            toolName: "",
            toolID: "",
            toolInput: "",
            role: "assistant",
          });
          this.emit({
            kind: EventKind.TurnEnd,
            time: new Date(),
            text: "",
            toolName: "",
            toolID: "",
            toolInput: "",
            role: "assistant",
          });
        }, 3500);
      }
    }

    const session = __test.createSession(new TurnEndWrapper() as never);
    const startedAt = Date.now();

    const result = await session.prompt("inspect the repo");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3400);
  });

  test("stop lets queued events drain before ending events()", async () => {
    class QueueingWrapper extends FakeSessionWrapper {
      push(event: Event): void {
        this.emit(event);
      }
    }

    const wrapper = new QueueingWrapper();
    const session = __test.createSession(wrapper as never);
    const events = session.events()[Symbol.asyncIterator]();

    wrapper.push({
      kind: EventKind.AssistantText,
      time: new Date(),
      text: "first",
      toolName: "",
      toolID: "",
      toolInput: "",
      role: "assistant",
    });
    expect((await events.next()).value?.text).toBe("first");

    wrapper.push({
      kind: EventKind.AssistantText,
      time: new Date(),
      text: "second",
      toolName: "",
      toolID: "",
      toolInput: "",
      role: "assistant",
    });
    await session.stop();

    expect((await events.next()).value?.text).toBe("second");
    expect((await events.next()).done).toBe(true);
  });
});
