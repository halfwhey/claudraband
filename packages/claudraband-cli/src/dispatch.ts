import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DISPATCH_ENV = "CLAUDRABAND_RUNTIME_DISPATCHED";

export function isBunRuntime(globalObject: typeof globalThis = globalThis): boolean {
  return typeof (globalObject as typeof globalThis & { Bun?: unknown }).Bun !== "undefined";
}

export function shouldDispatchToBun(options: {
  bunRuntime: boolean;
  bunAvailable: boolean;
  alreadyDispatched: boolean;
}): boolean {
  return !options.bunRuntime && options.bunAvailable && !options.alreadyDispatched;
}

export function hasBunBinary(
  spawn: typeof spawnSync = spawnSync,
): boolean {
  const result = spawn("bun", ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

export function dispatchToBun(
  moduleUrl: string,
  argv: string[],
  spawn: typeof spawnSync = spawnSync,
): never {
  const entry = fileURLToPath(moduleUrl);
  const result = spawn("bun", [entry, ...argv], {
    stdio: "inherit",
    env: { ...process.env, [DISPATCH_ENV]: "1" },
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}
