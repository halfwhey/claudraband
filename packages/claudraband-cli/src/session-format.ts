import type { SessionSummary } from "claudraband-core";

export interface DaemonSessionListItem {
  sessionId: string;
  alive: boolean;
  hasPendingPermission: boolean;
}

export function formatLocalSessionLine(session: SessionSummary): string {
  return formatLocalSessionRows([session])[0];
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

export function formatLocalSessionList(sessions: SessionSummary[]): string[] {
  return formatGroupedSessionLines(
    sessions,
    (item) => item.alive,
    (items) => formatLocalSessionRows(items),
    (left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
      left.sessionId.localeCompare(right.sessionId),
  );
}

export function formatDaemonSessionList(
  sessions: DaemonSessionListItem[],
): string[] {
  return formatGroupedSessionLines(
    sessions,
    (item) => item.alive,
    (items) => items.map((item) => formatDaemonSessionLine(item)),
    (left, right) => left.sessionId.localeCompare(right.sessionId),
  );
}

function formatGroupedSessionLines<T>(
  sessions: T[],
  isLive: (item: T) => boolean,
  formatMany: (items: T[]) => string[],
  compare: (left: T, right: T) => number,
): string[] {
  const sorted = [...sessions].sort((left, right) => {
    const leftLive = isLive(left);
    const rightLive = isLive(right);
    if (leftLive !== rightLive) {
      return leftLive ? -1 : 1;
    }
    return compare(left, right);
  });
  const formatted = formatMany(sorted);

  const lines: string[] = [];
  let sawLive = false;
  let insertedSeparator = false;
  for (const [index, session] of sorted.entries()) {
    const live = isLive(session);
    if (!live && sawLive && !insertedSeparator && lines.length > 0) {
      lines.push("");
      insertedSeparator = true;
    }
    if (live) sawLive = true;
    lines.push(formatted[index]);
  }
  return lines;
}

function formatLocalSessionRows(sessions: SessionSummary[]): string[] {
  const rows = sessions.map((session) => ({
    sessionId: session.sessionId,
    status: `status=${session.source === "live" ? "live" : "history"}`,
    backend: `backend=${session.backend}`,
    cwd: `cwd=${session.cwd}`,
    updatedAt: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "",
    title: session.title ?? "(untitled)",
  }));

  const widths = {
    sessionId: Math.max(0, ...rows.map((row) => row.sessionId.length)),
    status: Math.max(0, ...rows.map((row) => row.status.length)),
    backend: Math.max(0, ...rows.map((row) => row.backend.length)),
    cwd: Math.max(0, ...rows.map((row) => row.cwd.length)),
    updatedAt: Math.max(0, ...rows.map((row) => row.updatedAt.length)),
  };

  return rows.map((row) => [
    row.sessionId.padEnd(widths.sessionId),
    row.status.padEnd(widths.status),
    row.backend.padEnd(widths.backend),
    row.cwd.padEnd(widths.cwd),
    widths.updatedAt > 0 ? row.updatedAt.padEnd(widths.updatedAt) : "",
    row.title,
  ].filter(Boolean).join("  ").trimEnd());
}
