import { describe, expect, test } from "bun:test";
import { awaitPaneIdle } from "./activity";

describe("awaitPaneIdle", () => {
  test("returns idle when capture is immediately stable", async () => {
    const capture = () => Promise.resolve("static content");

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 3,
      timeoutMs: 2000,
    });

    expect(result).toBe("idle");
  });

  test("returns idle after content stops changing", async () => {
    let callCount = 0;
    const capture = () => {
      callCount++;
      // Change content for the first 4 calls, then stabilize.
      if (callCount <= 4) {
        return Promise.resolve(`frame-${callCount}`);
      }
      return Promise.resolve("final-frame");
    };

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 3,
      timeoutMs: 2000,
    });

    expect(result).toBe("idle");
    // 1 initial + 4 changing + 3 stable = at least 8 calls
    expect(callCount).toBeGreaterThanOrEqual(8);
  });

  test("returns timeout when content never stabilizes", async () => {
    let callCount = 0;
    const capture = () => Promise.resolve(`always-different-${callCount++}`);

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 3,
      timeoutMs: 100,
    });

    expect(result).toBe("timeout");
  });

  test("returns aborted when signal is already aborted", async () => {
    const capture = () => Promise.resolve("content");
    const ac = new AbortController();
    ac.abort();

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 3,
      signal: ac.signal,
    });

    expect(result).toBe("aborted");
  });

  test("returns aborted when signal fires during polling", async () => {
    const capture = () => Promise.resolve(`changing-${Date.now()}`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 100, // Would never stabilize
      timeoutMs: 5000,
      signal: ac.signal,
    });

    expect(result).toBe("aborted");
  });

  test("resets stability counter when content changes again", async () => {
    let callCount = 0;
    const capture = () => {
      callCount++;
      // Stable for 2 captures (not enough for stableCount=3), then change, then stabilize.
      if (callCount <= 1) return Promise.resolve("phase-1");
      if (callCount <= 3) return Promise.resolve("phase-2"); // 2 consecutive (not enough)
      if (callCount === 4) return Promise.resolve("phase-3"); // reset
      return Promise.resolve("phase-final"); // stabilize here
    };

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 3,
      timeoutMs: 2000,
    });

    expect(result).toBe("idle");
    // Must have gone through the reset; needs at least 4 + 3 + 1 captures
    expect(callCount).toBeGreaterThanOrEqual(8);
  });

  test("respects custom stableCount", async () => {
    let callCount = 0;
    const capture = () => {
      callCount++;
      return Promise.resolve("stable");
    };

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 5,
      timeoutMs: 2000,
    });

    expect(result).toBe("idle");
    // 1 initial capture + 5 stable checks
    expect(callCount).toBe(6);
  });

  test("requires a visible change before declaring idle when configured", async () => {
    const capture = () => Promise.resolve("unchanged");

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 3,
      timeoutMs: 100,
      requireChangeBeforeIdle: true,
    });

    expect(result).toBe("timeout");
  });

  test("ignores ANSI noise when comparing captures", async () => {
    let callCount = 0;
    const capture = () => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve("\u001b[31mhello\u001b[0m");
      }
      return Promise.resolve("hello");
    };

    const result = await awaitPaneIdle(capture, {
      intervalMs: 10,
      stableCount: 2,
      timeoutMs: 2000,
    });

    expect(result).toBe("idle");
  });
});
