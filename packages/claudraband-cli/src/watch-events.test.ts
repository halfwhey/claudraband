import { describe, expect, test } from "bun:test";
import { EventKind, type ClaudrabandEvent } from "claudraband-core";
import { replayAndFollowEvents } from "./watch-events";

function makeEvent(
  overrides: Partial<ClaudrabandEvent> & Pick<ClaudrabandEvent, "kind">,
): ClaudrabandEvent {
  return {
    kind: overrides.kind,
    time: overrides.time ?? new Date("2026-04-16T00:00:00.000Z"),
    text: overrides.text,
    toolName: overrides.toolName,
    toolID: overrides.toolID,
    toolInput: overrides.toolInput,
    role: overrides.role,
  };
}

async function collectFrames(
  replayed: ClaudrabandEvent[],
  liveEvents?: AsyncIterable<ClaudrabandEvent>,
): Promise<Array<{ event: ClaudrabandEvent; source: "replay" | "live" }>> {
  const frames: Array<{ event: ClaudrabandEvent; source: "replay" | "live" }> = [];
  for await (const frame of replayAndFollowEvents(replayed, liveEvents)) {
    frames.push(frame);
  }
  return frames;
}

describe("replayAndFollowEvents", () => {
  test("replays history before following live events", async () => {
    const replayed = [
      makeEvent({
        kind: EventKind.UserMessage,
        text: "hi",
        role: "user",
      }),
    ];
    const live = (async function* () {
      yield makeEvent({
        kind: EventKind.AssistantText,
        text: "hello",
        role: "assistant",
        time: new Date("2026-04-16T00:00:01.000Z"),
      });
    })();

    expect(await collectFrames(replayed, live)).toEqual([
      { event: replayed[0], source: "replay" },
      {
        event: makeEvent({
          kind: EventKind.AssistantText,
          text: "hello",
          role: "assistant",
          time: new Date("2026-04-16T00:00:01.000Z"),
        }),
        source: "live",
      },
    ]);
  });

  test("drops one overlapping live event at the replay boundary", async () => {
    const overlapping = makeEvent({
      kind: EventKind.AssistantText,
      text: "boundary",
      role: "assistant",
    });
    const liveOnly = makeEvent({
      kind: EventKind.TurnEnd,
      role: "assistant",
      time: new Date("2026-04-16T00:00:01.000Z"),
    });

    const live = (async function* () {
      yield overlapping;
      yield liveOnly;
    })();

    expect(await collectFrames([overlapping], live)).toEqual([
      { event: overlapping, source: "replay" },
      { event: liveOnly, source: "live" },
    ]);
  });
});
