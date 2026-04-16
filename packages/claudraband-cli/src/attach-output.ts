import {
  extractLastAssistantTurn,
  type ClaudrabandEvent,
} from "claudraband-core";

export function extractAttachTurnText(
  beforeEvents: ClaudrabandEvent[],
  afterEvents: ClaudrabandEvent[],
): string {
  return extractLastAssistantTurn(afterEvents.slice(beforeEvents.length)) ?? "";
}
