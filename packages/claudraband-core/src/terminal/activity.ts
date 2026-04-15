export interface PaneActivityOptions {
  /** Milliseconds between captures. Default: 250 */
  intervalMs?: number;
  /** Number of consecutive identical captures required to declare idle. Default: 3 */
  stableCount?: number;
  /** Maximum wait time in ms before giving up. Default: 60_000 */
  timeoutMs?: number;
  /** Require at least one visible change before stability can count as idle. */
  requireChangeBeforeIdle?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export type ActivityResult = "idle" | "timeout" | "aborted";

export function normalizePaneCapture(capture: string): string {
  return capture
    .replace(/\r/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(\d+)C/g, (_match, count: string) =>
      " ".repeat(Number.parseInt(count, 10) || 0))
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\[[0-9;]*[ABDHJKf]/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
}

/**
 * Poll `capture()` until the pane content is stable for `stableCount`
 * consecutive intervals. Backend-agnostic: works for tmux (capturePane)
 * and xterm (serialize) alike.
 *
 * Returns:
 * - `"idle"` when the pane has not changed for the required number of
 *   consecutive captures
 * - `"timeout"` if `timeoutMs` elapses before stability is reached
 * - `"aborted"` if the provided `signal` is aborted
 */
export async function awaitPaneIdle(
  capture: () => Promise<string>,
  options?: PaneActivityOptions,
): Promise<ActivityResult> {
  const intervalMs = options?.intervalMs ?? 250;
  const stableCount = options?.stableCount ?? 3;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const requireChangeBeforeIdle = options?.requireChangeBeforeIdle ?? false;
  const signal = options?.signal;

  if (signal?.aborted) return "aborted";

  const deadline = Date.now() + timeoutMs;
  let previous = normalizePaneCapture(await capture());
  let consecutiveStable = 0;
  let sawChange = false;

  while (Date.now() < deadline) {
    if (signal?.aborted) return "aborted";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // Clean up listener when timer fires normally.
        const origResolve = resolve;
        resolve = () => {
          signal.removeEventListener("abort", onAbort);
          origResolve();
        };
      }
    }).catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      throw err;
    });

    if (signal?.aborted) return "aborted";

    const current = normalizePaneCapture(await capture());

    if (current === previous) {
      consecutiveStable++;
      if (
        consecutiveStable >= stableCount &&
        (!requireChangeBeforeIdle || sawChange)
      ) {
        return "idle";
      }
    } else {
      sawChange = true;
      consecutiveStable = 0;
      previous = current;
    }
  }

  return "timeout";
}
