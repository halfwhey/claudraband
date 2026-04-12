export interface PaneActivityOptions {
  /** Milliseconds between captures. Default: 250 */
  intervalMs?: number;
  /** Number of consecutive identical captures required to declare idle. Default: 3 */
  stableCount?: number;
  /** Maximum wait time in ms before giving up. Default: 60_000 */
  timeoutMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export type ActivityResult = "idle" | "timeout" | "aborted";

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
  const signal = options?.signal;

  if (signal?.aborted) return "aborted";

  const deadline = Date.now() + timeoutMs;
  let previous = await capture();
  let consecutiveStable = 0;

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

    const current = await capture();

    if (current === previous) {
      consecutiveStable++;
      if (consecutiveStable >= stableCount) {
        return "idle";
      }
    } else {
      consecutiveStable = 0;
      previous = current;
    }
  }

  return "timeout";
}
