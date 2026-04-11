import { describe, expect, test } from "bun:test";
import {
  formatDaemonSessionLine,
  formatDaemonSessionList,
  formatLocalSessionLine,
  formatLocalSessionList,
} from "./session-format";

describe("session list formatting", () => {
  test("formats local sessions with live status", () => {
    const line = formatLocalSessionLine(
      {
        sessionId: "abc-123",
        cwd: "/repo",
        title: "review the diff",
        updatedAt: "2026-04-11T12:34:56.000Z",
      },
      true,
    );

    expect(line).toContain("abc-123");
    expect(line).toContain("status=live");
    expect(line).toContain("review the diff");
  });

  test("formats local sessions with saved status when not live", () => {
    const line = formatLocalSessionLine(
      {
        sessionId: "def-456",
        cwd: "/repo",
        title: undefined,
        updatedAt: undefined,
      },
      false,
    );

    expect(line).toBe("def-456  status=saved  (untitled)");
  });

  test("formats daemon sessions with status and pending flag", () => {
    const line = formatDaemonSessionLine({
      sessionId: "ghi-789",
      alive: true,
      hasPendingPermission: false,
    });

    expect(line).toBe("ghi-789  status=live  pending=no");
  });

  test("groups local sessions with live ones at the bottom", () => {
    const lines = formatLocalSessionList([
      {
        session: {
          sessionId: "live-1",
          cwd: "/repo",
          title: "live session",
          updatedAt: "2026-04-11T12:00:00.000Z",
        },
        isLive: true,
      },
      {
        session: {
          sessionId: "saved-2",
          cwd: "/repo",
          title: "older saved",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
        isLive: false,
      },
      {
        session: {
          sessionId: "saved-1",
          cwd: "/repo",
          title: "newer saved",
          updatedAt: "2026-04-11T11:00:00.000Z",
        },
        isLive: false,
      },
    ]);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("saved-1");
    expect(lines[1]).toContain("saved-2");
    expect(lines[2]).toBe("");
    expect(lines[3]).toContain("live-1");
  });

  test("groups daemon sessions with live ones at the bottom", () => {
    const lines = formatDaemonSessionList([
      {
        sessionId: "live-2",
        alive: true,
        hasPendingPermission: false,
      },
      {
        sessionId: "dead-2",
        alive: false,
        hasPendingPermission: false,
      },
      {
        sessionId: "dead-1",
        alive: false,
        hasPendingPermission: true,
      },
    ]);

    expect(lines).toEqual([
      "dead-1  status=dead  pending=yes",
      "dead-2  status=dead  pending=no",
      "",
      "live-2  status=live  pending=no",
    ]);
  });
});
