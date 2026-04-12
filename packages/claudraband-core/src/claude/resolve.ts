import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ENV_OVERRIDE = "CLAUDRABAND_CLAUDE_PATH";

export function resolveClaudeExecutable(explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  const envOverride = process.env[ENV_OVERRIDE];
  if (envOverride) {
    return envOverride;
  }

  try {
    const packageJsonPath = require.resolve("@anthropic-ai/claude-code/package.json");
    const packageJson = require(packageJsonPath) as {
      bin?: string | { claude?: string };
      version?: string;
    };
    const binPath = typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.claude;

    if (!binPath) {
      throw new Error("missing bin.claude entry");
    }

    const executable = join(dirname(packageJsonPath), binPath);
    if (!existsSync(executable)) {
      throw new Error(`resolved bin not found at ${executable}`);
    }
    return executable;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `claudraband could not resolve bundled Claude Code @anthropic-ai/claude-code@2.1.96 (${reason}). `
      + `Install dependencies or set ${ENV_OVERRIDE} or ClaudrabandOptions.claudeExecutable.`,
    );
  }
}

export const __test = {
  ENV_OVERRIDE,
};
