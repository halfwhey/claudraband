#!/usr/bin/env node
import {
  DISPATCH_ENV,
  dispatchToBun,
  hasBunBinary,
  isBunRuntime,
  shouldDispatchToBun,
} from "./dispatch";
import { runCli } from "./main";

export async function runBin(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (shouldDispatchToBun({
    bunRuntime: isBunRuntime(),
    bunAvailable: hasBunBinary(),
    alreadyDispatched: process.env[DISPATCH_ENV] === "1",
  })) {
    dispatchToBun(import.meta.url, argv);
  }

  await runCli(argv);
}

runBin().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : JSON.stringify(err);
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
