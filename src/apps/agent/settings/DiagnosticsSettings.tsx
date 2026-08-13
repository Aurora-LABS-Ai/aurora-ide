/**
 * Agent Window — Settings · Diagnostics (view).
 *
 * Aurora has always written failures to `aurora.log` and never offered a way to
 * read them; you had to know the path. This is that way.
 *
 * It is a RECENT PROBLEMS list, not a live tail. On a healthy install the file
 * is nearly empty, and a scrolling console would be a mostly-blank panel
 * pretending to be busy. Every row here is something that actually went wrong,
 * newest first, and the empty state says so as good news rather than as an
 * error of its own.
 *
 * "Send to agent" is the reason this beats opening the file in Notepad: you are
 * using Aurora to build Aurora, and the shortest path from "something broke" to
 * "it's fixed" is handing the agent its own crash. It fills the composer and
 * stops — sending is still the person's decision.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import {
  clearAuroraIssues,
  clearLogs,
  readAuroraIssues,
  readRecentLogs,
  type AuroraIssueReport,
  type LogEntry,
  type LogSnapshot,
} from "@/kernel/services/diagnostics";
import { AgentIcon } from "../shared/AgentIcon";
import { AgentConfirm } from "@/apps/agent/components/modals/AgentConfirm";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import {
  newChatDraftKey,
  useAgentDraftStore,
} from "@/apps/agent/store/conversation/useAgentDraftStore";
import {
  AgwButton,
  AgwPill,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
  type PillTone,
} from "./primitives";

/** How many entries to pull. More than anyone reads; the file holds the rest. */
const READ_LIMIT = 300;

/** Ceiling on what "Send to agent" drops into the composer. */
const SEND_MAX_ENTRIES = 40;

/**
 * Levels that mean something failed. `INFO` is excluded — startup stamps and
 * "log cleared" are trace, and listing them under "Recent problems" would make
 * a healthy launch look like an incident.
 */
const PROBLEM_LEVELS = new Set(["ERROR", "PANIC", "WARN", "RAW"]);

const isProblem = (entry: LogEntry): boolean => PROBLEM_LEVELS.has(entry.level);

const toneOf = (level: string): PillTone => {
  if (level === "PANIC" || level === "ERROR") return "danger";
  if (level === "WARN") return "warning";
  if (level === "RAW") return "neutral";
  return "info";
};

/** `RAW` is a torn line, not a level — say what it means where it is shown. */
const levelLabel = (level: string): string => (level === "RAW" ? "UNPARSED" : level);

/** One `report_aurora_issue` entry, split out of the append-only markdown. */
interface IssueEntry {
  /** `2026-08-13 07:41:02Z · thread \`abc\`` — the stamp Aurora wrote. */
  heading: string;
  /** First non-empty body line; what the row shows collapsed. */
  summary: string;
  body: string;
}

/**
 * Split the issues file into entries.
 *
 * The file is append-only markdown where Aurora writes every `## ` heading
 * itself, so splitting on that is reading its own format rather than guessing
 * at the model's. Anything before the first heading (a hand-edit, a stray
 * newline) is ignored rather than shown as a headless entry.
 */
function parseIssues(content: string): IssueEntry[] {
  const entries: IssueEntry[] = [];
  const lines = content.split(/\r?\n/);
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading === null) return;
    const text = body.join("\n").trim();
    entries.push({
      heading,
      summary: text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "(empty report)",
      body: text,
    });
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

/** `2026-08-13 07:41:02Z · thread `abc`` → the two halves, for the row. */
function splitHeading(heading: string): { when: string; thread: string } {
  const [when, thread] = heading.split("·").map((part) => part.trim());
  return { when: when || heading, thread: (thread ?? "").replace(/^thread\s*/, "").replace(/`/g, "") };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local clock time; the full stamp lives in the expanded detail. */
function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDay(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The log's own line shape, so what is copied matches what is on disk. */
const asLogLine = (e: LogEntry): string =>
  e.level === "RAW" ? e.message : `[${e.at}] [${e.level}] [${e.component}] ${e.message}`;

export const DiagnosticsSettings: React.FC = () => {
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [issues, setIssues] = useState<AuroraIssueReport | null>(null);
  const [issueOpen, setIssueOpen] = useState<string | null>(null);
  const [confirmClearIssues, setConfirmClearIssues] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await readRecentLogs(READ_LIMIT));
      setReadError(null);
    } catch (error) {
      // A diagnostics page that fails silently is a joke at the user's expense.
      setReadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // Read separately from the log: the two are different records, and a failure
  // to read one must not blank the other.
  const loadIssues = useCallback(async () => {
    try {
      setIssues(await readAuroraIssues());
    } catch (error) {
      setIssues({
        path: "",
        exists: false,
        content: `Could not read the reported issues: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, []);

  useEffect(() => {
    void load();
    void loadIssues();
  }, [load, loadIssues]);

  // Newest first: the thing that just broke is what you came for.
  const problems = useMemo(() => {
    const all = snapshot?.entries ?? [];
    return all.filter(isProblem).reverse();
  }, [snapshot]);

  const startedAt = useMemo(() => {
    const startup = [...(snapshot?.entries ?? [])]
      .reverse()
      .find((e) => e.component === "startup");
    return startup ? `${formatDay(startup.at)} ${formatTime(startup.at)}` : null;
  }, [snapshot]);

  const copyAll = async () => {
    await navigator.clipboard.writeText(problems.map(asLogLine).join("\n"));
    setCopied(true);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const sendToAgent = () => {
    const { currentThreadId, projectRoot } = useAgentChatStore.getState();
    const lines = problems.slice(0, SEND_MAX_ENTRIES).map(asLogLine);
    const omitted = problems.length - lines.length;
    const text = [
      "Aurora logged these failures. Find the cause and fix it.",
      "",
      "```",
      ...lines,
      ...(omitted > 0 ? [`… ${omitted} older ${omitted === 1 ? "entry" : "entries"} not shown`] : []),
      "```",
    ].join("\n");

    const key = currentThreadId ?? newChatDraftKey(projectRoot);
    const existing = useAgentDraftStore.getState().getDraft(key);
    // Never overwrite something half-written; append below it.
    useAgentDraftStore.getState().setDraft(key, existing ? `${existing}\n\n${text}` : text);
    // Closing to the chat IS the confirmation — the text is sitting in the
    // composer, which no label on a button now off-screen could say better.
    useAgentUiStore.getState().closeSettings();
  };

  const showFile = () => {
    if (!snapshot?.path) return;
    void auroraInvoke("reveal_in_explorer", { path: snapshot.path }).catch(() => {
      setReadError("Could not open the folder. The path above still works.");
    });
  };

  const doClear = () => {
    setConfirmClear(false);
    void clearLogs().then(load);
  };

  // Newest first, same as the log: the file is append-only, so the newest entry
  // is the last one written.
  const issueEntries = useMemo(
    () => parseIssues(issues?.content ?? "").reverse(),
    [issues],
  );

  const showIssuesFile = () => {
    if (!issues?.path) return;
    void auroraInvoke("reveal_in_explorer", { path: issues.path }).catch(() => {
      setReadError("Could not open the folder. The path above still works.");
    });
  };

  const doClearIssues = () => {
    setConfirmClearIssues(false);
    setIssueOpen(null);
    void clearAuroraIssues().then(loadIssues);
  };

  const count = problems.length;

  return (
    <div className="agw-set-wide">
      <SettingsSection
        title="Recent problems"
        icon="diagnostics"
        description={
          startedAt
            ? `Everything that failed since this window opened at ${startedAt}, newest first.`
            : "Everything Aurora has recorded as a failure, newest first."
        }
        badge={
          count > 0 ? (
            <AgwPill tone="danger">
              {count} {count === 1 ? "problem" : "problems"}
            </AgwPill>
          ) : (
            <AgwPill tone="success">All clear</AgwPill>
          )
        }
      >
        <SettingsBlock searchTerms="log error crash failure diagnostics copy send to agent refresh">
          <div className="agw-diag-actions">
            <AgwButton icon="retry" onClick={() => void load()} disabled={loading}>
              {loading ? "Reading…" : "Refresh"}
            </AgwButton>
            <AgwButton icon="copy" onClick={() => void copyAll()} disabled={count === 0}>
              {copied ? "Copied" : "Copy all"}
            </AgwButton>
            <AgwButton variant="primary" icon="send" onClick={sendToAgent} disabled={count === 0}>
              Send to agent
            </AgwButton>
          </div>
        </SettingsBlock>

        <SettingsBlock last searchTerms="log entries errors warnings panic stack trace">
          {readError ? (
            <div className="agw-diag-state" data-tone="danger" role="alert">
              <AgentIcon name="alert" size={16} />
              <div>
                <div className="agw-diag-state-title">Could not read the log</div>
                <div className="agw-diag-state-body">{readError}</div>
              </div>
            </div>
          ) : loading && !snapshot ? (
            <div className="agw-diag-state" role="status">
              Reading the log…
            </div>
          ) : count === 0 ? (
            <div className="agw-diag-state" data-tone="success" role="status">
              <AgentIcon name="check" size={16} />
              <div>
                <div className="agw-diag-state-title">Nothing has failed.</div>
                <div className="agw-diag-state-body">
                  Errors, crashes and warnings appear here as they happen — from both the
                  interface and the engine behind it.
                </div>
              </div>
            </div>
          ) : (
            <ol className="agw-diag-list agw-scroll">
              {problems.map((entry, index) => {
                const id = `${entry.at}:${index}`;
                const open = expanded === id;
                return (
                  <li key={id} className="agw-diag-item" data-open={open || undefined}>
                    <button
                      type="button"
                      className="agw-diag-head"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : id)}
                    >
                      <span className="agw-set-pill" data-tone={toneOf(entry.level)}>
                        <span className="agw-set-pill-dot" />
                        {levelLabel(entry.level)}
                      </span>
                      <span className="agw-diag-when">{formatTime(entry.at)}</span>
                      <span className="agw-diag-where">{entry.component || "—"}</span>
                      <span className="agw-diag-msg">{entry.message}</span>
                      <AgentIcon
                        name="chevron-down"
                        size={13}
                        style={{
                          flexShrink: 0,
                          transform: open ? "rotate(180deg)" : "none",
                          transition: "transform 0.16s cubic-bezier(0, 0, 0.2, 1)",
                        }}
                      />
                    </button>
                    {open && (
                      <div className="agw-diag-detail">
                        <div className="agw-diag-detail-meta">
                          {formatDay(entry.at)} · {entry.at || "no timestamp"}
                        </div>
                        {/* The stored `\n` escapes are put back, because a
                            stack trace on one line is not a stack trace. */}
                        <pre className="agw-diag-detail-body">
                          {entry.message.split("\\n").join("\n")}
                        </pre>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {snapshot?.truncated && (
            <p className="agw-diag-note">
              Older entries exist than the {READ_LIMIT} read here — open the file for the rest.
            </p>
          )}
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        title="Log file"
        icon="file-read"
        description="One file on disk, written by both halves of Aurora. It survives crashes and restarts, so a failure is still there after the window is gone."
      >
        <SettingsRow
          alignTop
          label="Location"
          searchTerms="path folder open reveal explorer finder aurora.log"
          hint={
            <code className="agw-diag-path">{snapshot?.path || "Resolving…"}</code>
          }
        >
          <AgwButton icon="folder" onClick={showFile} disabled={!snapshot?.path}>
            Show in folder
          </AgwButton>
        </SettingsRow>

        <SettingsRow
          label="Size"
          searchTerms="rotation size bytes aurora.log.1 backup"
          hint={
            snapshot?.hasBackup
              ? "Rotates to aurora.log.1 at 5 MB, so one file back of history survives."
              : "Rotates to a single backup at 5 MB, so it can never fill the disk."
          }
        >
          <span className="agw-diag-size">{formatBytes(snapshot?.bytes ?? 0)}</span>
        </SettingsRow>

        <SettingsRow
          last
          label="Clear the log"
          searchTerms="delete empty reset wipe logs"
          hint="Empties the file and drops the backup. Worth doing before reproducing a bug, so what you send is only the bug."
        >
          <AgwButton variant="danger" icon="trash" onClick={() => setConfirmClear(true)}>
            Clear
          </AgwButton>
        </SettingsRow>
      </SettingsSection>

      {/* What the AGENT reported, which is not what Aurora noticed about
          itself: the log is Aurora's own account of a failure, these are the
          faults the agent hit while trying to use it — wrong tool output, a
          path that does not exist, a success that changed nothing. Written by
          the `report_aurora_issue` tool the moment it happens, because an
          observation held until the end of a turn is one compaction away from
          being lost. */}
      <SettingsSection
        title="Reported by the agent"
        icon="alert"
        description="Faults the agent hit in Aurora itself and recorded as they happened. Each one names what it called, what came back, and what it expected."
        badge={
          issueEntries.length > 0 ? (
            <AgwPill tone="warning">
              {issueEntries.length} {issueEntries.length === 1 ? "report" : "reports"}
            </AgwPill>
          ) : (
            <AgwPill tone="success">None</AgwPill>
          )
        }
      >
        <SettingsBlock searchTerms="agent report aurora issue bug feedback tool wrong">
          {issueEntries.length === 0 ? (
            <div className="agw-diag-state" data-tone="success" role="status">
              <AgentIcon name="check" size={16} />
              <div>
                <div className="agw-diag-state-title">Nothing reported.</div>
                <div className="agw-diag-state-body">
                  The agent records a report here the moment Aurora behaves incorrectly — and
                  is told not to report its own mistakes, so anything that appears is worth
                  reading.
                </div>
              </div>
            </div>
          ) : (
            <ol className="agw-diag-list agw-scroll">
              {issueEntries.map((entry, index) => {
                const id = `${entry.heading}:${index}`;
                const open = issueOpen === id;
                const { when, thread } = splitHeading(entry.heading);
                return (
                  <li key={id} className="agw-diag-item" data-open={open || undefined}>
                    <button
                      type="button"
                      className="agw-diag-head"
                      aria-expanded={open}
                      onClick={() => setIssueOpen(open ? null : id)}
                    >
                      <span className="agw-diag-when">{when}</span>
                      <span className="agw-diag-msg">{entry.summary}</span>
                      <AgentIcon
                        name="chevron-down"
                        size={13}
                        style={{
                          flexShrink: 0,
                          transform: open ? "rotate(180deg)" : "none",
                          transition: "transform 0.16s cubic-bezier(0, 0, 0.2, 1)",
                        }}
                      />
                    </button>
                    {open && (
                      <div className="agw-diag-detail">
                        <div className="agw-diag-detail-meta">
                          {when}
                          {thread ? ` · conversation ${thread}` : ""}
                        </div>
                        {/* Rendered as written. The agent authors this text and
                            the file is append-only, so what is shown is exactly
                            what was recorded — reformatting it would put words
                            in its mouth. */}
                        <pre className="agw-diag-detail-body">{entry.body}</pre>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </SettingsBlock>

        <SettingsRow
          alignTop
          label="Location"
          searchTerms="path folder reveal aurora-issues.md reports"
          hint={
            <code className="agw-diag-path">
              {issues?.path || "Nothing written yet — the file is created on the first report."}
            </code>
          }
        >
          <AgwButton icon="folder" onClick={showIssuesFile} disabled={!issues?.exists}>
            Show in folder
          </AgwButton>
        </SettingsRow>

        <SettingsRow
          last
          label="Clear reports"
          searchTerms="delete reset wipe agent reports issues"
          hint="Deletes the file. The agent recreates it the next time it reports something."
        >
          <AgwButton
            variant="danger"
            icon="trash"
            onClick={() => setConfirmClearIssues(true)}
            disabled={!issues?.exists}
          >
            Clear
          </AgwButton>
        </SettingsRow>
      </SettingsSection>

      <AgentConfirm
        open={confirmClearIssues}
        destructive
        title="Clear the agent's reports?"
        message="Every fault the agent recorded about Aurora is deleted. This cannot be undone, and these are the ones nobody else was watching for."
        confirmLabel="Clear reports"
        onConfirm={doClearIssues}
        onCancel={() => setConfirmClearIssues(false)}
      />

      <AgentConfirm
        open={confirmClear}
        destructive
        title="Clear the log?"
        message="Every recorded failure is deleted, including the rotated backup. This cannot be undone, and anything you have not copied or sent to the agent is gone."
        confirmLabel="Clear the log"
        onConfirm={doClear}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
};
