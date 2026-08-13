/**
 * Diagnostics — frontend access to `aurora.log`.
 *
 * Aurora has always written failures to
 * `%LOCALAPPDATA%\AuroraIDE\logs\aurora.log` and never offered a way to read
 * them. This is the client behind Settings → Diagnostics.
 *
 * Reporting is deliberately one-way and silent on failure: an error reporter
 * that can raise its own error is how one failure becomes a loop.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/kernel/lib/ipc/tauri";

export interface LogEntry {
  /** ISO-8601 UTC, exactly as written to the file. */
  at: string;
  /** `ERROR` | `WARN` | `INFO` | `PANIC`, or `RAW` for a line that did not parse. */
  level: string;
  /** Subsystem that logged it — `api.responses`, `ui.crash`, … */
  component: string;
  message: string;
}

export interface LogSnapshot {
  path: string;
  /** Oldest first, matching the file. */
  entries: LogEntry[];
  bytes: number;
  /** Older entries exist than the ones returned. */
  truncated: boolean;
  /** A rotated `aurora.log.1` sits beside it. */
  hasBackup: boolean;
}

const EMPTY: LogSnapshot = {
  path: "",
  entries: [],
  bytes: 0,
  truncated: false,
  hasBackup: false,
};

interface RawSnapshot {
  path: string;
  entries: LogEntry[];
  bytes: number;
  truncated: boolean;
  has_backup: boolean;
}

export async function readRecentLogs(limit = 300): Promise<LogSnapshot> {
  if (!isTauri()) return EMPTY;
  const raw = await invoke<RawSnapshot>("logs_recent", { limit });
  return {
    path: raw.path,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    bytes: raw.bytes,
    truncated: raw.truncated,
    hasBackup: raw.has_backup,
  };
}

export async function clearLogs(): Promise<void> {
  if (!isTauri()) return;
  await invoke("logs_clear");
}

/**
 * What the AGENT has reported about Aurora, via the `report_aurora_issue` tool.
 *
 * A different kind of record from the log: the log is what Aurora noticed about
 * itself, this is what the agent noticed while trying to use it.
 */
export interface AuroraIssueReport {
  path: string;
  /** False = nothing has ever been reported, which is not the same as empty. */
  exists: boolean;
  /** Raw markdown, oldest entry first — the file is append-only. */
  content: string;
}

const NO_ISSUES: AuroraIssueReport = { path: "", exists: false, content: "" };

export async function readAuroraIssues(): Promise<AuroraIssueReport> {
  if (!isTauri()) return NO_ISSUES;
  return await invoke<AuroraIssueReport>("aurora_issues_read");
}

export async function clearAuroraIssues(): Promise<void> {
  if (!isTauri()) return;
  await invoke("aurora_issues_clear");
}

/** Record a web-layer failure into the same file the backend writes to. */
export async function reportToLog(
  level: "error" | "warn",
  component: string,
  message: string,
): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("logs_report", { level, component, message });
  } catch {
    // Swallowed on purpose — see the module note.
  }
}
