import { describe, expect, test } from "bun:test";
import { __test, EventKind } from "./index";
import type { ClaudrabandEvent } from "./index";
import type { Event } from "./wrap/event";
import type { Wrapper } from "./wrap/wrapper";

class FakeWrapper implements Wrapper {
  private queue: Event[] = [];
  private waiters: Array<(result: IteratorResult<Event>) => void> = [];
  private done = false;
  sent: string[] = [];

  name(): string {
    return "fake";
  }

  model(): string {
    return "sonnet";
  }

  async start(_signal: AbortSignal): Promise<void> {}

  async stop(): Promise<void> {
    this.close();
  }

  async send(input: string): Promise<void> {
    this.sent.push(input);
  }

  async interrupt(): Promise<void> {
    this.sent.push("C-c");
  }

  alive(): boolean {
    return !this.done;
  }

  async *events(): AsyncGenerator<Event> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<Event>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }

  push(event: Event): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined, done: true } as IteratorResult<Event>);
    }
    this.waiters = [];
  }

  async capturePane(): Promise<string> {
    return "";
  }

  setModel(_model: string): void {}

  setPermissionMode(_mode: string): void {}

  async restart(): Promise<void> {}
}

function ev(partial: Partial<Event> & { kind: EventKind }): Event {
  return {
    time: new Date(),
    text: "",
    toolName: "",
    toolID: "",
    toolInput: "",
    role: "",
    ...partial,
  };
}

async function collect(
  iterable: AsyncIterable<ClaudrabandEvent>,
  sink: ClaudrabandEvent[],
): Promise<void> {
  for await (const event of iterable) {
    sink.push(event);
  }
}

describe("claudraband session runtime", () => {
  test("keeps streaming late events while no prompt is active", async () => {
    const wrapper = new FakeWrapper();
    const session = __test.createSession(wrapper);
    const seen: ClaudrabandEvent[] = [];
    const stream = collect(session.events(), seen);

    const prompt1 = session.prompt("first prompt");
    wrapper.push(ev({ kind: EventKind.UserMessage, text: "first prompt" }));
    wrapper.push(
      ev({ kind: EventKind.AssistantText, text: "Let me update my memory..." }),
    );

    const result1 = await prompt1;
    expect(result1.stopReason).toBe("end_turn");

    wrapper.push(
      ev({
        kind: EventKind.ToolCall,
        toolName: "Write",
        toolID: "write-1",
        toolInput: JSON.stringify({ path: "/tmp/memory.md", content: "x" }),
      }),
    );
    wrapper.push(
      ev({
        kind: EventKind.ToolResult,
        toolID: "write-1",
        text: "ok",
      }),
    );
    wrapper.push(
      ev({
        kind: EventKind.AssistantText,
        text: "Done. I've updated my memory.",
      }),
    );

    await Bun.sleep(20);

    expect(seen.map((event) => event.kind)).toEqual([
      EventKind.UserMessage,
      EventKind.AssistantText,
      EventKind.ToolCall,
      EventKind.ToolResult,
      EventKind.AssistantText,
    ]);
    expect(seen[4]?.text).toContain("updated my memory");

    wrapper.close();
    await stream;
    await session.stop();
  });

  test("ignores orphaned old-turn events until the new prompt echo appears", async () => {
    const wrapper = new FakeWrapper();
    const session = __test.createSession(wrapper);
    const seen: ClaudrabandEvent[] = [];
    const stream = collect(session.events(), seen);

    const prompt = session.prompt("Delete the binaries in the folder");

    wrapper.push(
      ev({
        kind: EventKind.AssistantText,
        text: "Done. I've updated my memory.",
      }),
    );

    let settled = false;
    prompt.then(() => {
      settled = true;
    });

    await Bun.sleep(50);
    expect(settled).toBe(false);

    wrapper.push(
      ev({
        kind: EventKind.UserMessage,
        text: "Delete the binaries in the folder",
      }),
    );
    wrapper.push(
      ev({
        kind: EventKind.AssistantText,
        text: "I'll delete the binaries in the folder.",
      }),
    );
    wrapper.close();

    const result = await prompt;
    expect(result.stopReason).toBe("end_turn");
    expect(seen[0]?.text).toContain("updated my memory");
    expect(seen[1]?.text).toBe("Delete the binaries in the folder");
    expect(seen[2]?.text).toContain("delete the binaries");

    await stream;
    await session.stop();
  });

  test("does not offer free-form AskUserQuestion responses unless enabled", () => {
    const question = {
      question: "What should I do?",
      header: "Claude has a question",
      multiSelect: false,
      options: [
        { label: "Yes", description: "Proceed" },
        { label: "No", description: "Stop" },
      ],
    };

    const acpOptions = __test.buildAskUserQuestionOptions(question, false);
    expect(acpOptions.map((option) => option.name)).toEqual([
      "Yes — Proceed",
      "No — Stop",
      "Cancel",
    ]);
    expect(acpOptions.some((option) => option.textInput)).toBe(false);

    const cliOptions = __test.buildAskUserQuestionOptions(question, true);
    expect(cliOptions.map((option) => option.name)).toEqual([
      "Yes — Proceed",
      "No — Stop",
      "Type a response",
      "Cancel",
    ]);
    expect(cliOptions.find((option) => option.textInput)?.name).toBe("Type a response");
  });
});
