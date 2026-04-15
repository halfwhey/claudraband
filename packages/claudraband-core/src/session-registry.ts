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

export interface KnownSessionRecord {
  version: 1;
  sessionId: string;
  cwd: string;
  backend: ResolvedTerminalBackend;
  title?: string;
  createdAt: string;
  updatedAt: string;
  transcriptPath?: string;
  owner?: SessionOwnerRecord;
}

function registryRoot(): string {
  return process.env.CLAUDRABAND_HOME || join(homedir(), ".claudraband");
}

function sessionsDir(): string {
  return join(registryRoot(), "sessions");
}

function knownSessionsDir(): string {
  return join(registryRoot(), "known-sessions");
}

function sessionFilePath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

function knownSessionFilePath(sessionId: string): string {
  return join(knownSessionsDir(), `${sessionId}.json`);
}

export async function ensureSessionRegistry(): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true });
  await mkdir(knownSessionsDir(), { recursive: true });
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
  return listRecordDir<SessionRecord>(sessionsDir());
}

export async function readKnownSessionRecord(
  sessionId: string,
): Promise<KnownSessionRecord | null> {
  try {
    const text = await readFile(knownSessionFilePath(sessionId), "utf8");
    return JSON.parse(text) as KnownSessionRecord;
  } catch {
    return null;
  }
}

export async function listKnownSessionRecords(): Promise<KnownSessionRecord[]> {
  return listRecordDir<KnownSessionRecord>(knownSessionsDir());
}

async function listRecordDir<T>(dir: string): Promise<T[]> {
  try {
    const files = await readdir(dir);
    const records: Array<T | null> = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const text = await readFile(join(dir, file), "utf8");
            return JSON.parse(text) as T;
          } catch {
            return null;
          }
        }),
    );
    return records.filter((record): record is T => record !== null);
  } catch {
    return [];
  }
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionRegistry();
  const targetPath = sessionFilePath(record.sessionId);
  await writeRecordFile(targetPath, record);
}

export async function writeKnownSessionRecord(record: KnownSessionRecord): Promise<void> {
  await ensureSessionRegistry();
  const targetPath = knownSessionFilePath(record.sessionId);
  await writeRecordFile(targetPath, record);
}

async function writeRecordFile(targetPath: string, record: object): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(record, null, 2));
  await rename(tempPath, targetPath);
}

export async function deleteSessionRecord(sessionId: string): Promise<void> {
  await rm(sessionFilePath(sessionId), { force: true }).catch(() => {});
}

export async function deleteKnownSessionRecord(sessionId: string): Promise<void> {
  await rm(knownSessionFilePath(sessionId), { force: true }).catch(() => {});
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
