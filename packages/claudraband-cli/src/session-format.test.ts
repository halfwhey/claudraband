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
        createdAt: "2026-04-10T12:34:56.000Z",
        backend: "tmux",
        alive: true,
        reattachable: true,
        owner: { kind: "local" },
        title: "review the diff",
        updatedAt: "2026-04-11T12:34:56.000Z",
      },
    );

    expect(line).toContain("abc-123");
    expect(line).toContain("status=live");
    expect(line).toContain("backend=tmux");
    expect(line).toContain("cwd=/repo");
    expect(line).toContain("review the diff");
  });

  test("formats local sessions with saved status when not live", () => {
    const line = formatLocalSessionLine(
      {
        sessionId: "def-456",
        cwd: "/repo",
        createdAt: "2026-04-10T12:34:56.000Z",
        backend: "xterm",
        alive: false,
        reattachable: false,
        owner: { kind: "local" },
        title: undefined,
        updatedAt: undefined,
      },
    );

    expect(line).toBe("def-456  status=saved  backend=xterm  cwd=/repo  (untitled)");
  });

  test("formats daemon sessions with status and pending flag", () => {
    const line = formatDaemonSessionLine({
      sessionId: "ghi-789",
      alive: true,
      hasPendingPermission: false,
    });

    expect(line).toBe("ghi-789  status=live  pending=no");
  });

  test("groups local sessions with live ones at the top", () => {
    const lines = formatLocalSessionList([
      {
        sessionId: "live-1",
        cwd: "/repo",
        createdAt: "2026-04-10T12:00:00.000Z",
        backend: "tmux",
        alive: true,
        reattachable: true,
        owner: { kind: "local" },
        title: "live session",
        updatedAt: "2026-04-11T12:00:00.000Z",
      },
      {
        sessionId: "saved-2",
        cwd: "/repo",
        createdAt: "2026-04-10T10:00:00.000Z",
        backend: "tmux",
        alive: false,
        reattachable: true,
        owner: { kind: "local" },
        title: "older saved",
        updatedAt: "2026-04-11T10:00:00.000Z",
      },
      {
        sessionId: "saved-1",
        cwd: "/repo",
        createdAt: "2026-04-10T11:00:00.000Z",
        backend: "tmux",
        alive: false,
        reattachable: true,
        owner: { kind: "local" },
        title: "newer saved",
        updatedAt: "2026-04-11T11:00:00.000Z",
      },
    ]);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("live-1");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("saved-1");
    expect(lines[3]).toContain("saved-2");
  });

  test("groups daemon sessions with live ones at the top", () => {
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
      "live-2  status=live  pending=no",
      "",
      "dead-1  status=dead  pending=yes",
      "dead-2  status=dead  pending=no",
    ]);
  });
});
