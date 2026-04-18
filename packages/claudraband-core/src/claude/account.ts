import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeAccountStateErrorKind =
  | "bundle_not_writable"
  | "not_onboarded";

export interface ClaudeAccountPaths {
  homeDir: string;
  claudeDir: string;
  claudeJsonPath: string;
  credentialsPath: string;
}

export interface ClaudeAccountState {
  paths: ClaudeAccountPaths;
  hasCompletedOnboarding: boolean;
}

export class ClaudeAccountStateError extends Error {
  readonly kind: ClaudeAccountStateErrorKind;
  readonly paths: ClaudeAccountPaths;

  constructor(
    kind: ClaudeAccountStateErrorKind,
    message: string,
    paths: ClaudeAccountPaths,
  ) {
    super(message);
    this.name = "ClaudeAccountStateError";
    this.kind = kind;
    this.paths = paths;
  }
}

export interface InspectClaudeAccountStateOptions {
  homeDir?: string;
}

export function resolveClaudeAccountPaths(homeDir = homedir()): ClaudeAccountPaths {
  return {
    homeDir,
    claudeDir: join(homeDir, ".claude"),
    claudeJsonPath: join(homeDir, ".claude.json"),
    credentialsPath: join(homeDir, ".claude", ".credentials.json"),
  };
}

function bundleNotWritable(
  paths: ClaudeAccountPaths,
  targetPath: string,
  detail: string,
): ClaudeAccountStateError {
  return new ClaudeAccountStateError(
    "bundle_not_writable",
    `Claude account state exists but is not writable by the current user. ${detail} (${targetPath}). Expected writable Claude state at ${paths.claudeDir} and ${paths.claudeJsonPath}. This usually means the bundle was created by an older root-based container image. Fix the host bundle ownership or recreate it, then retry.`,
    paths,
  );
}

function notOnboarded(
  paths: ClaudeAccountPaths,
  detail: string,
): ClaudeAccountStateError {
  return new ClaudeAccountStateError(
    "not_onboarded",
    `Claude account state is not onboarded yet. ${detail} Run Claude once to finish onboarding, then retry. Expected ${paths.claudeJsonPath} to contain hasCompletedOnboarding=true and ${paths.credentialsPath} to exist with credentials.`,
    paths,
  );
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function inspectClaudeAccountState(
  options: InspectClaudeAccountStateOptions = {},
): Promise<ClaudeAccountState> {
  const paths = resolveClaudeAccountPaths(options.homeDir);

  try {
    const claudeDirStat = await stat(paths.claudeDir);
    if (!claudeDirStat.isDirectory()) {
      throw bundleNotWritable(
        paths,
        paths.claudeDir,
        "Expected a directory",
      );
    }
  } catch (error) {
    if (error instanceof ClaudeAccountStateError) throw error;
    if (isMissingError(error)) {
      throw notOnboarded(
        paths,
        `Missing Claude state directory at ${paths.claudeDir}.`,
      );
    }
    throw error;
  }

  try {
    await access(paths.claudeDir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw bundleNotWritable(
      paths,
      paths.claudeDir,
      "Expected a readable and writable directory",
    );
  }

  try {
    const claudeJsonStat = await stat(paths.claudeJsonPath);
    if (!claudeJsonStat.isFile()) {
      throw bundleNotWritable(
        paths,
        paths.claudeJsonPath,
        "Expected a file",
      );
    }
  } catch (error) {
    if (error instanceof ClaudeAccountStateError) throw error;
    if (isMissingError(error)) {
      throw notOnboarded(
        paths,
        `Missing Claude config file at ${paths.claudeJsonPath}.`,
      );
    }
    throw error;
  }

  try {
    await access(paths.claudeJsonPath, constants.R_OK | constants.W_OK);
  } catch {
    throw bundleNotWritable(
      paths,
      paths.claudeJsonPath,
      "Expected a readable and writable file",
    );
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(await readFile(paths.claudeJsonPath, "utf8"));
  } catch {
    throw notOnboarded(
      paths,
      `${paths.claudeJsonPath} is missing or contains invalid JSON.`,
    );
  }

  const hasCompletedOnboarding =
    parsedConfig !== null
    && typeof parsedConfig === "object"
    && "hasCompletedOnboarding" in parsedConfig
    && parsedConfig.hasCompletedOnboarding === true;

  if (!hasCompletedOnboarding) {
    throw notOnboarded(
      paths,
      `${paths.claudeJsonPath} does not indicate completed onboarding.`,
    );
  }

  let credentialsStat;
  try {
    credentialsStat = await stat(paths.credentialsPath);
    if (!credentialsStat.isFile()) {
      throw bundleNotWritable(
        paths,
        paths.credentialsPath,
        "Expected a file",
      );
    }
  } catch (error) {
    if (error instanceof ClaudeAccountStateError) throw error;
    if (isMissingError(error)) {
      throw notOnboarded(
        paths,
        `Missing credential file at ${paths.credentialsPath}.`,
      );
    }
    throw error;
  }

  try {
    await access(paths.credentialsPath, constants.R_OK | constants.W_OK);
  } catch {
    throw bundleNotWritable(
      paths,
      paths.credentialsPath,
      "Expected a readable and writable credential file",
    );
  }

  if (credentialsStat.size < 2) {
    throw notOnboarded(
      paths,
      `${paths.credentialsPath} is empty.`,
    );
  }

  return {
    paths,
    hasCompletedOnboarding: true,
  };
}
