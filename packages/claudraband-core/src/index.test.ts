import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudraband, EventKind, __test } from "./index";
import { sessionPath } from "./claude";
import { readSessionRecord, writeKnownSessionRecord } from "./session-registry";
import { awaitPaneIdle } from "./terminal/activity";
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

  async awaitIdle(options?: Parameters<typeof awaitPaneIdle>[1]) {
    return awaitPaneIdle(() => this.capturePane(), options);
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

const TRUST_FOLDER_PROMPT = `Is this a project you created and trust?
❯ 1. Yes, I trust this folder
  2. No, exit`;

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
      expect(found?.source).toBe("live");
      expect(found?.alive).toBe(true);
      expect(found?.reattachable).toBe(true);
    } finally {
      await session?.kill().catch(() => {});
    }
  });

  test("reclassifies live tmux sessions as local after a daemon owner goes stale", async () => {
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
      await writeKnownSessionRecord({
        version: 1,
        sessionId,
        cwd: "/tmp",
        backend: "tmux",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        transcriptPath: sessionPath("/tmp", sessionId),
        owner: {
          kind: "daemon",
          serverUrl: "http://127.0.0.1:7842",
          serverPid: 999_999,
          serverInstanceId: "dead-daemon",
        },
      });

      const runtime = createClaudraband({
        terminalBackend: "tmux",
      });
      const sessions = await runtime.listSessions("/tmp");
      const found = sessions.find((entry) => entry.sessionId === sessionId);
      const record = await readSessionRecord(sessionId);

      expect(found?.owner.kind).toBe("local");
      expect(found?.source).toBe("live");
      expect(found?.alive).toBe(true);
      expect(record?.owner.kind).toBe("local");
      expect(record?.lastKnownAlive).toBe(true);
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
      expect(await runtime.inspectSession(sessionId, "/tmp")).toBeNull();
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
      expect(found?.source).toBe("live");
      expect(found?.alive).toBe(true);

      const closed = await runtime.closeSession(sessionId);
      expect(closed).toBe(true);
      expect(deleted).toEqual([sessionId]);
      expect(await runtime.inspectSession(sessionId)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(join(registryHome, "sessions", `${sessionId}.json`), {
        force: true,
      });
    }
  });

  test("keeps daemon-owned sessions live when the daemon pid is not local", async () => {
    const sessionId = randomUUID();
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessions: [{ sessionId, alive: true }],
        }));
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
          title: "container daemon session",
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          lastKnownAlive: true,
          reattachable: true,
          owner: {
            kind: "daemon",
            serverUrl: `http://127.0.0.1:${address.port}`,
            serverPid: 999_999,
            serverInstanceId: "container-daemon-test",
          },
        }),
      );

      const runtime = createClaudraband();
      const sessions = await runtime.listSessions();
      const found = sessions.find((session) => session.sessionId === sessionId);

      expect(found?.owner.kind).toBe("daemon");
      expect(found?.source).toBe("live");
      expect(found?.alive).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(join(registryHome, "sessions", `${sessionId}.json`), {
        force: true,
      });
    }
  });

  test("lists only claudraband-tracked transcript sessions as history", async () => {
    const sessionId = randomUUID();
    const cwd = `/tmp/claudraband-history-${sessionId}`;
    const transcript = sessionPath(cwd, sessionId);
    const unrelatedId = randomUUID();
    const unrelatedCwd = `/tmp/unrelated-history-${unrelatedId}`;
    const unrelatedTranscript = sessionPath(unrelatedCwd, unrelatedId);

    try {
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "history session output that is long enough to pass the size filter" }] },
          session_id: sessionId,
        })}\n`,
      );
      await mkdir(join(unrelatedTranscript, ".."), { recursive: true });
      await writeFile(
        unrelatedTranscript,
        `${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "unrelated standalone claude output that should not appear in claudraband sessions" }] },
          session_id: unrelatedId,
        })}\n`,
      );
      await writeKnownSessionRecord({
        version: 1,
        sessionId,
        cwd,
        backend: "tmux",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        transcriptPath: transcript,
      });

      const runtime = createClaudraband();
      const sessions = await runtime.listSessions();
      const found = sessions.find((session) => session.sessionId === sessionId);
      const unrelated = sessions.find((session) => session.sessionId === unrelatedId);

      expect(found?.source).toBe("history");
      expect(found?.alive).toBe(false);
      expect(unrelated).toBeUndefined();
      expect(await readSessionRecord(sessionId)).toBeNull();
    } finally {
      await rm(join(transcript, ".."), { recursive: true, force: true });
      await rm(join(unrelatedTranscript, ".."), { recursive: true, force: true });
    }
  });

  test("inspects a dead daemon-owned session without losing daemon ownership", async () => {
    const sessionId = randomUUID();
    const cwd = `/tmp/claudraband-daemon-history-${sessionId}`;
    const transcript = sessionPath(cwd, sessionId);

    try {
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "text",
              text: "daemon-owned history session output that is long enough to pass the size filter",
            }],
          },
          session_id: sessionId,
        })}\n`,
      );
      await writeKnownSessionRecord({
        version: 1,
        sessionId,
        cwd,
        backend: "tmux",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        transcriptPath: transcript,
        owner: {
          kind: "daemon",
          serverUrl: "http://127.0.0.1:7842",
          serverPid: 12345,
          serverInstanceId: "daemon-test",
        },
      });

      const runtime = createClaudraband();
      const found = await runtime.inspectSession(sessionId, cwd);

      expect(found?.owner.kind).toBe("daemon");
      expect(found?.source).toBe("live");
      expect(found?.alive).toBe(false);
    } finally {
      await rm(join(transcript, ".."), { recursive: true, force: true });
    }
  });

  test("sessionPath matches Claude project directory escaping", () => {
    expect(sessionPath("/tmp/claudraband-host-1.1b_IVaduZ", "sid")).toBe(
      join(
        homedir(),
        ".claude",
        "projects",
        "-tmp-claudraband-host-1-1b-IVaduZ",
        "sid.jsonl",
      ),
    );
  });

  test("detach keeps live tmux sessions tracked", async () => {
    const sessionId = randomUUID();
    const cwd = "/tmp/claudraband-host-1.1b.IVaduZ";
    const session = __test.createSession(new FakeSessionWrapper() as never, {
      sessionId,
      cwd,
      backend: "tmux",
    });

    await (session as unknown as { syncSessionRecord(): Promise<void> }).syncSessionRecord();
    await session.detach();

    const record = await readSessionRecord(sessionId);
    expect(record?.lastKnownAlive).toBe(true);
    expect(record?.reattachable).toBe(true);
    expect(record?.transcriptPath).toBe(sessionPath(cwd, sessionId));
  });

  test("interrupt markers clear stale in-progress transcript state", async () => {
    const sessionId = randomUUID();
    const cwd = `/tmp/claudraband-interrupt-${sessionId}`;
    const transcript = sessionPath(cwd, sessionId);

    try {
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(
        transcript,
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "run sleep" },
            sessionId,
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "toolu_interrupt",
                name: "Bash",
                input: { command: "sleep 30" },
              }],
              stop_reason: "tool_use",
            },
            sessionId,
          }),
          JSON.stringify({
            type: "system",
            subtype: "interrupt",
            content: "interrupt",
            sessionId,
          }),
          "",
        ].join("\n"),
      );
      await writeKnownSessionRecord({
        version: 1,
        sessionId,
        cwd,
        backend: "tmux",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        transcriptPath: transcript,
      });

      const status = await createClaudraband().getStatus(sessionId, cwd);

      expect(status?.alive).toBe(false);
      expect(status?.turnInProgress).toBe(false);
    } finally {
      await rm(join(transcript, ".."), { recursive: true, force: true });
    }
  });

  test("awaitTurn returns immediately when the session is already idle", async () => {
    class IdleReadyWrapper extends FakeSessionWrapper {
      override async capturePane(): Promise<string> {
        return "Claude is idle\nNORMAL";
      }
    }

    const session = __test.createSession(new IdleReadyWrapper() as never);
    const result = await Promise.race([
      session.awaitTurn(),
      Bun.sleep(250).then(() => "timeout" as const),
    ]);

    expect(result).toEqual({ stopReason: "end_turn" });
  });

  test("awaitTurn waits for TurnEnd when the transcript is mid-turn", async () => {
    // isReadyForFreshInput should not short-circuit when the JSONL transcript
    // is still mid-turn. We simulate that by pointing the session at a
    // transcript that has a UserMessage + AssistantText but no TurnEnd yet.
    const { writeFile, mkdir, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const sessionId = randomUUID();
    const fakeCwd = `/tmp/claudraband-await-test-${sessionId}`;
    const transcript = join(
      homedir(),
      ".claude",
      "projects",
      fakeCwd.replace(/\//g, "-"),
      `${sessionId}.jsonl`,
    );

    try {
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(
        transcript,
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "prompt" },
            session_id: sessionId,
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "working..." }],
            },
            session_id: sessionId,
          }),
          "",
        ].join("\n"),
      );

      class MidTurnWrapper extends FakeSessionWrapper {
        private scheduled = false;
        override async capturePane(): Promise<string> {
          if (!this.scheduled) {
            this.scheduled = true;
            setTimeout(() => {
              this.emit({
                kind: EventKind.TurnEnd,
                time: new Date(),
                text: "",
                toolName: "",
                toolID: "",
                toolInput: "",
                role: "assistant",
              });
              this.finish();
            }, 200);
          }
          return "Assistant: still working...\nINSERT";
        }
      }

      const session = __test.createSession(
        new MidTurnWrapper() as never,
        { sessionId, cwd: fakeCwd },
      );
      const startedAt = Date.now();
      const result = await session.awaitTurn();

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    } finally {
      await rm(join(transcript, ".."), { recursive: true, force: true });
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

  test("sendAndAwaitTurn does not send a native prompt selection twice", async () => {
    class NativePromptWrapper extends FakeSessionWrapper {
      sent: string[] = [];
      private pane = TRUST_FOLDER_PROMPT;

      override async send(input: string): Promise<void> {
        this.sent.push(input);
        if (input !== "1") {
          throw new Error(`unexpected input: ${input}`);
        }
        this.pane = "INSERT";
        this.emit({
          kind: EventKind.ToolResult,
          time: new Date(),
          text: "trusted",
          toolName: "",
          toolID: "native-prompt",
          toolInput: "",
          role: "user",
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
        setTimeout(() => this.finish(), 10);
      }

      override async capturePane(): Promise<string> {
        return this.pane;
      }
    }

    const wrapper = new NativePromptWrapper();
    const session = __test.createSession(wrapper as never, {
      onPermissionRequest: async () => ({ outcome: "selected", optionId: "1" }),
    });

    const result = await session.sendAndAwaitTurn("1");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(wrapper.sent).toEqual(["1"]);
  });

  test("sendAndAwaitTurn returns after consuming a startup native prompt", async () => {
    class AcceptStartupWrapper extends FakeSessionWrapper {
      sent: string[] = [];
      private pane = TRUST_FOLDER_PROMPT;

      override async send(input: string): Promise<void> {
        this.sent.push(input);
        if (input !== "1") {
          throw new Error(`unexpected input: ${input}`);
        }
        this.pane = "INSERT";
      }

      override async capturePane(): Promise<string> {
        return this.pane;
      }
    }

    const wrapper = new AcceptStartupWrapper();
    const session = __test.createSession(wrapper as never, {
      onPermissionRequest: async () => ({ outcome: "selected", optionId: "1" }),
    });

    const result = await session.sendAndAwaitTurn("1");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(wrapper.sent).toEqual(["1"]);
  });

  test("prompt stops cleanly after rejecting a startup native prompt", async () => {
    class RejectingStartupWrapper extends FakeSessionWrapper {
      sent: string[] = [];
      private pane = TRUST_FOLDER_PROMPT;

      override async send(input: string): Promise<void> {
        this.sent.push(input);
        if (input !== "2") {
          throw new Error(`unexpected input: ${input}`);
        }
        this.finish();
      }

      override async capturePane(): Promise<string> {
        return this.pane;
      }
    }

    const wrapper = new RejectingStartupWrapper();
    const session = __test.createSession(wrapper as never, {
      onPermissionRequest: async () => ({ outcome: "selected", optionId: "2" }),
    });

    const result = await session.prompt("hello");

    expect(result).toEqual({ stopReason: "cancelled" });
    expect(wrapper.sent).toEqual(["2"]);
  });

  test("rejecting a startup native prompt tolerates pane disappearance", async () => {
    class VanishingRejectWrapper extends FakeSessionWrapper {
      private pane = TRUST_FOLDER_PROMPT;

      override async send(input: string): Promise<void> {
        if (input !== "2") {
          throw new Error(`unexpected input: ${input}`);
        }
        this.finish();
        throw new Error("can't find pane: %567");
      }

      override async capturePane(): Promise<string> {
        return this.pane;
      }
    }

    const session = __test.createSession(new VanishingRejectWrapper() as never, {
      onPermissionRequest: async () => ({ outcome: "selected", optionId: "2" }),
    });

    const result = await session.prompt("hello");

    expect(result).toEqual({ stopReason: "cancelled" });
  });

  test("repeated polling of the same native prompt does not re-ask permission", async () => {
    class StickyNativePromptWrapper extends FakeSessionWrapper {
      override async capturePane(): Promise<string> {
        return TRUST_FOLDER_PROMPT;
      }

      override async send(_input: string): Promise<void> {}
    }

    let calls = 0;
    const session = __test.createSession(new StickyNativePromptWrapper() as never, {
      onPermissionRequest: async () => {
        calls++;
        return { outcome: "selected", optionId: "1" };
      },
    });

    const first = await (session as any).pollNativePermission(null, "1");
    const second = await (session as any).pollNativePermission(null, "1");

    expect(first).toBe("consumed");
    expect(second).toBe("pending_clear");
    expect(calls).toBe(1);
  });

  test("a deferred native prompt can be answered on a later poll", async () => {
    class StickyDeferredPromptWrapper extends FakeSessionWrapper {
      sent: string[] = [];

      override async capturePane(): Promise<string> {
        return TRUST_FOLDER_PROMPT;
      }

      override async send(input: string): Promise<void> {
        this.sent.push(input);
      }
    }

    let calls = 0;
    const wrapper = new StickyDeferredPromptWrapper();
    const session = __test.createSession(wrapper as never, {
      onPermissionRequest: async () => {
        calls++;
        if (calls === 1) {
          return { outcome: "deferred" };
        }
        return { outcome: "selected", optionId: "1" };
      },
    });

    const first = await (session as any).pollNativePermission(null, "1");
    const second = await (session as any).pollNativePermission(null, "1");

    expect(first).toBe("deferred");
    expect(second).toBe("consumed");
    expect(calls).toBe(2);
    expect(wrapper.sent).toEqual(["1"]);
  });

  test("prompt waits for the terminal to stabilize before ending the turn", async () => {
    class StableTerminalWrapper extends PromptLifecycleWrapper {
      private startedAt = 0;

      override async send(input: string): Promise<void> {
        this.startedAt = Date.now();
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
        }, 350);
      }

      override async capturePane(): Promise<string> {
        const elapsed = Date.now() - this.startedAt;
        if (elapsed < 250) {
          return "Claude\nworking 1";
        }
        if (elapsed < 550) {
          return "Claude\nworking 2";
        }
        return "Claude\nfinished";
      }
    }

    const session = __test.createSession(new StableTerminalWrapper() as never);
    const startedAt = Date.now();

    const result = await session.prompt("inspect the repo");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
  });

  test("prompt still ends promptly on explicit TurnEnd before the terminal stabilizes", async () => {
    class TurnEndWrapper extends PromptLifecycleWrapper {
      override async send(input: string): Promise<void> {
        await super.send(input);
        this.emit({
          kind: EventKind.AssistantText,
          time: new Date(),
          text: "Done",
          toolName: "",
          toolID: "",
          toolInput: "",
          role: "assistant",
        });
        setTimeout(() => {
          this.emit({
            kind: EventKind.TurnEnd,
            time: new Date(),
            text: "",
            toolName: "",
            toolID: "",
            toolInput: "",
            role: "assistant",
          });
          this.finish();
        }, 200);
      }

      override async capturePane(): Promise<string> {
        return `still-changing-${Date.now()}`;
      }
    }

    const session = __test.createSession(new TurnEndWrapper() as never);
    const startedAt = Date.now();

    const result = await session.prompt("inspect the repo");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("events turn detection still completes from transcript-idle fallback", async () => {
    class EventsModeWrapper extends FakeSessionWrapper {
      override async send(input: string): Promise<void> {
        if (input !== "2") {
          throw new Error(`unexpected input: ${input}`);
        }
        this.emit({
          kind: EventKind.AssistantText,
          time: new Date(),
          text: "Working on it",
          toolName: "",
          toolID: "",
          toolInput: "",
          role: "assistant",
        });
      }

      override async capturePane(): Promise<string> {
        return `still-changing-${Date.now()}`;
      }
    }

    const session = __test.createSession(new EventsModeWrapper() as never, {
      turnDetection: "events",
    });
    const startedAt = Date.now();

    const result = await session.sendAndAwaitTurn("2");

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5900);
    expect(Date.now() - startedAt).toBeLessThan(8000);
  }, 10_000);

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

  test("flushEvents waits for direct-delivery subscribers to finish consuming", async () => {
    class QueueingWrapper extends FakeSessionWrapper {
      push(event: Event): void {
        this.emit(event);
      }
    }

    const wrapper = new QueueingWrapper();
    const session = __test.createSession(wrapper as never);
    const events = session.events()[Symbol.asyncIterator]();

    const firstNext = events.next();
    wrapper.push({
      kind: EventKind.AssistantText,
      time: new Date(),
      text: "first",
      toolName: "",
      toolID: "",
      toolInput: "",
      role: "assistant",
    });

    expect((await firstNext).value?.text).toBe("first");

    let flushed = false;
    const flushPromise = session.flushEvents().then(() => {
      flushed = true;
    });

    await Bun.sleep(20);
    expect(flushed).toBe(false);

    const closeNext = events.next();
    await session.stop();
    await closeNext;
    await flushPromise;

    expect(flushed).toBe(true);
  });
});

describe("session transcript paths", () => {
  test("normalizes cwd before deriving the Claude project transcript path", () => {
    expect(sessionPath("/tmp/", "abc-123")).toBe(sessionPath("/tmp", "abc-123"));
  });
});
