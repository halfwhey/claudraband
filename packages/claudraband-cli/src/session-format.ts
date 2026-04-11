import type { SessionSummary } from "claudraband-core";

export interface DaemonSessionListItem {
  sessionId: string;
  alive: boolean;
  hasPendingPermission: boolean;
}

export interface LocalSessionListItem {
  session: SessionSummary;
  isLive: boolean;
}

export function formatLocalSessionLine(
  session: SessionSummary,
  isLive: boolean,
): string {
  const date = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "";
  return [
    session.sessionId,
    `status=${isLive ? "live" : "saved"}`,
    date,
    session.title ?? "(untitled)",
  ].filter(Boolean).join("  ");
}

export function formatDaemonSessionLine(
  session: DaemonSessionListItem,
): string {
  return [
    session.sessionId,
    `status=${session.alive ? "live" : "dead"}`,
    `pending=${session.hasPendingPermission ? "yes" : "no"}`,
  ].join("  ");
}

export function formatLocalSessionList(
  sessions: LocalSessionListItem[],
): string[] {
  return formatGroupedSessionLines(
    sessions,
    (item) => item.isLive,
    (item) => formatLocalSessionLine(item.session, item.isLive),
    (left, right) =>
      (right.session.updatedAt ?? "").localeCompare(left.session.updatedAt ?? "") ||
      left.session.sessionId.localeCompare(right.session.sessionId),
  );
}

export function formatDaemonSessionList(
  sessions: DaemonSessionListItem[],
): string[] {
  return formatGroupedSessionLines(
    sessions,
    (item) => item.alive,
    (item) => formatDaemonSessionLine(item),
    (left, right) => left.sessionId.localeCompare(right.sessionId),
  );
}

function formatGroupedSessionLines<T>(
  sessions: T[],
  isLive: (item: T) => boolean,
  format: (item: T) => string,
  compare: (left: T, right: T) => number,
): string[] {
  const sorted = [...sessions].sort((left, right) => {
    const leftLive = isLive(left);
    const rightLive = isLive(right);
    if (leftLive !== rightLive) {
      return leftLive ? 1 : -1;
    }
    return compare(left, right);
  });

  const lines: string[] = [];
  let sawLive = false;
  for (const session of sorted) {
    const live = isLive(session);
    if (live && !sawLive && lines.length > 0) {
      lines.push("");
      sawLive = true;
    } else if (live) {
      sawLive = true;
    }
    lines.push(format(session));
  }
  return lines;
}
