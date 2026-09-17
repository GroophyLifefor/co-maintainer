import { readConfig } from "../../config.ts";
import { cancel } from "../../services/jobs.ts";
import { clearRemoteToolBridge } from "../tool_bridge.ts";

export type RemoteSession = {
  jobId: string;
  reviewId: string;
  tokenId: string;
  subjectId: string;
  lastSyncAt: number;
};

export type RemoteSyncResult = Record<string, unknown>;

const sessions = new Map<string, RemoteSession>();
const finishedResults = new Map<string, RemoteSyncResult>();
let watchdogTimer: ReturnType<typeof setInterval> | undefined;

export function openRemoteSession(session: Omit<RemoteSession, "lastSyncAt">): void {
  sessions.set(session.jobId, { ...session, lastSyncAt: Date.now() });
}

export function touchRemoteSession(jobId: string): void {
  const session = sessions.get(jobId);
  if (session) session.lastSyncAt = Date.now();
}

export function getRemoteSession(jobId: string): RemoteSession | undefined {
  return sessions.get(jobId);
}

export function closeRemoteSession(jobId: string): void {
  sessions.delete(jobId);
  clearRemoteToolBridge(jobId);
  setTimeout(() => finishedResults.delete(jobId), 60_000);
}

export function setRemoteSyncResult(jobId: string, result: RemoteSyncResult): void {
  finishedResults.set(jobId, result);
}

export function getRemoteSyncResult(jobId: string): RemoteSyncResult | undefined {
  return finishedResults.get(jobId);
}

export function startRemoteWatchdog(): void {
  if (watchdogTimer !== undefined) return;
  watchdogTimer = setInterval(() => {
    const timeoutMs = (readConfig().remoteSyncTimeoutSeconds ?? 10) * 1000;
    const now = Date.now();
    for (const [jobId, session] of sessions) {
      if (now - session.lastSyncAt > timeoutMs) {
        cancel(jobId, "client_timeout");
        closeRemoteSession(jobId);
      }
    }
  }, 1000);
}

export function stopRemoteWatchdog(): void {
  if (watchdogTimer !== undefined) {
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  }
}
