import type { ClaudrabandEvent } from "claudraband-core";

export interface WatchEventFrame {
  event: ClaudrabandEvent;
  source: "replay" | "live";
}

function eventFingerprint(event: ClaudrabandEvent): string {
  return JSON.stringify({
    kind: event.kind,
    time: event.time.toISOString(),
    text: event.text ?? null,
    toolName: event.toolName ?? null,
    toolID: event.toolID ?? null,
    toolInput: event.toolInput ?? null,
    role: event.role ?? null,
  });
}

function rememberReplayEvent(
  seen: Map<string, number>,
  event: ClaudrabandEvent,
): void {
  const key = eventFingerprint(event);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}

function isReplayDuplicate(
  seen: Map<string, number>,
  event: ClaudrabandEvent,
): boolean {
  const key = eventFingerprint(event);
  const remaining = seen.get(key) ?? 0;
  if (remaining === 0) {
    return false;
  }
  if (remaining === 1) {
    seen.delete(key);
  } else {
    seen.set(key, remaining - 1);
  }
  return true;
}

export async function* replayAndFollowEvents(
  replayed: ClaudrabandEvent[],
  liveEvents?: AsyncIterable<ClaudrabandEvent>,
): AsyncGenerator<WatchEventFrame> {
  const replayFingerprints = new Map<string, number>();
  for (const event of replayed) {
    rememberReplayEvent(replayFingerprints, event);
    yield { event, source: "replay" };
  }

  if (!liveEvents) {
    return;
  }

  for await (const event of liveEvents) {
    if (isReplayDuplicate(replayFingerprints, event)) {
      continue;
    }
    yield { event, source: "live" };
  }
}
