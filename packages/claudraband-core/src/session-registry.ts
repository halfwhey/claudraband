import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { ResolvedTerminalBackend } from "./terminal";

export interface LocalSessionOwnerRecord {
  kind: "local";
  pid?: number;
}

export interface DaemonSessionOwnerRecord {
  kind: "daemon";
  serverUrl: string;
  serverPid?: number;
  serverInstanceId: string;
}

export type SessionOwnerRecord =
  | LocalSessionOwnerRecord
  | DaemonSessionOwnerRecord;

export interface SessionRecord {
  version: 1;
  sessionId: string;
  cwd: string;
  backend: ResolvedTerminalBackend;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastKnownAlive: boolean;
  reattachable: boolean;
  transcriptPath?: string;
  owner: SessionOwnerRecord;
}

function registryRoot(): string {
  return process.env.CLAUDRABAND_HOME || join(homedir(), ".claudraband");
}

function sessionsDir(): string {
  return join(registryRoot(), "sessions");
}

function sessionFilePath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

export async function ensureSessionRegistry(): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true });
}

export async function readSessionRecord(
  sessionId: string,
): Promise<SessionRecord | null> {
  try {
    const text = await readFile(sessionFilePath(sessionId), "utf8");
    return JSON.parse(text) as SessionRecord;
  } catch {
    return null;
  }
}

export async function listSessionRecords(): Promise<SessionRecord[]> {
  try {
    const files = await readdir(sessionsDir());
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const text = await readFile(join(sessionsDir(), file), "utf8");
            return JSON.parse(text) as SessionRecord;
          } catch {
            return null;
          }
        }),
    );
    return records.filter((record): record is SessionRecord => record !== null);
  } catch {
    return [];
  }
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionRegistry();
  const targetPath = sessionFilePath(record.sessionId);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(record, null, 2));
  await rename(tempPath, targetPath);
}

export async function deleteSessionRecord(sessionId: string): Promise<void> {
  await rm(sessionFilePath(sessionId), { force: true }).catch(() => {});
}

export function normalizeServerUrl(server: string): string {
  return server.startsWith("http://") || server.startsWith("https://")
    ? server.replace(/\/+$/, "")
    : `http://${server}`.replace(/\/+$/, "");
}

export function isPidAlive(pid?: number): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
