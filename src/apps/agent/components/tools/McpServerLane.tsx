/**
 * Agent Window — MCP server lane [view].
 *
 * A run of consecutive calls to ONE MCP server, drawn as one thing.
 *
 * Every other tool card reports work Aurora did on this machine. This is the
 * one row where the code that ran is not Aurora's: a payload went to someone
 * else's server and something came back. Two consequences shape the whole
 * component.
 *
 * **The server is named once.** Calls to a server arrive in runs, so drawing
 * the server's id on every row spends the same twenty-three characters three
 * times and leaves the operation and the outcome fighting for what is left. The
 * header carries the identity and the facts that belong to the CONNECTION
 * rather than to any one call — transport, how many calls, total time — and each
 * line below carries only what is different about it.
 *
 * **The line says what happened, not what was invoked.** The operation is set
 * as words (`mcpOperationLabel`), and the outcome is derived from the returned
 * object's own top-level fields, so three calls to one server never read
 * identically. Nothing here knows anything about Postgres, or about any other
 * server: a result is JSON with flat fields, or it is not, and both cases have
 * an answer.
 *
 * Chrome is Aurora's own throughout. The lettered tile is `.agw-prov-avatar`
 * from Providers at row scale, the rule under the header is the one an expanded
 * tool body already draws, and the open body reuses `ToolCode` and
 * `ToolResultView` — which means it is height-capped and scrolls internally
 * exactly like a file read or a terminal result, and never grows the message.
 */

import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { ToolCode } from "@/apps/agent/components/tool-views/ToolCode";
import { ToolResultView } from "@/apps/agent/components/tool-views/ToolResultView";
import { parseToolResult } from "@/apps/agent/components/tool-views/tool-result";
import { mcpOperationLabel, parseMcpToolName } from "@/apps/agent/services/tools/mcp-tools";
import { useMcpStore } from "@/apps/agent/store/tools/useMcpStore";
import { mcpCallForCard } from "./mcp-card";
import { formatToolDuration, toolStatus, type ToolCall, type ToolStatus } from "./tool-call";

/**
 * A run this long gets a bounded, internally scrolling body — the same
 * treatment and the same ceiling `.agw-tool-group-body` gives a long tool run,
 * for the same reason: one lane must not be able to push the rest of the
 * message off screen. Below it the lane is its natural height.
 */
const LANE_SCROLL_MIN_CALLS = 6;

/** Arguments longer than this are the payload, not a setting. */
const PAYLOAD_MIN_CHARS = 120;
/** Past this the panel is a wall; `ToolCode` also stops highlighting at 50k. */
const PAYLOAD_MAX_CHARS = 50_000;
/** A chip is a glance, not a read. Matches the tool card's own argument chips. */
const CHIP_MAX_CHARS = 40;

/**
 * What the field is written in, so the payload renders as itself.
 *
 * Keyed on the ARGUMENT NAME, not on the content. A field called `sql` holds
 * SQL because the server said so in its schema; sniffing the string would guess
 * at it and be confidently wrong on the short ones. Anything unlisted renders
 * as plain text, which is the honest answer for an arbitrary blob.
 */
const PAYLOAD_LANGUAGE: Record<string, string> = {
  code: "py",
  command: "sh",
  css: "css",
  html: "html",
  javascript: "js",
  js: "js",
  json: "json",
  markdown: "md",
  python: "py",
  query: "sql",
  script: "py",
  sql: "sql",
  text: "txt",
  xml: "xml",
  yaml: "yaml",
};

interface LanePayload {
  key: string;
  path: string;
  text: string;
  truncated: boolean;
}

interface LaneRequest {
  chips: [string, string][];
  payload: LanePayload | null;
}

/**
 * Split the arguments by SIZE, not by name: the short scalars are settings and
 * become chips, and the one long field is the thing you opened the card to
 * read, so it gets a panel. A call with no long field gets chips alone, which is
 * the shape the file tools already use.
 */
function splitRequest(args: Record<string, unknown> | null): LaneRequest {
  const chips: [string, string][] = [];
  let payload: LanePayload | null = null;
  if (!args) return { chips, payload };

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length >= PAYLOAD_MIN_CHARS) {
      // Several long strings in one call is possible; the first wins the panel
      // and the rest become chips, because two panels in a row is a wall with a
      // gap in it.
      if (!payload) {
        payload = {
          key,
          path: `payload.${PAYLOAD_LANGUAGE[key.toLowerCase()] ?? "txt"}`,
          text: value.slice(0, PAYLOAD_MAX_CHARS),
          truncated: value.length > PAYLOAD_MAX_CHARS,
        };
        continue;
      }
    }
    let rendered: string;
    if (value === null || value === undefined) rendered = "null";
    else if (Array.isArray(value)) rendered = `[${value.length} items]`;
    else if (typeof value === "object") rendered = "{…}";
    else rendered = String(value).slice(0, CHIP_MAX_CHARS);
    chips.push([key, rendered]);
  }
  return { chips, payload };
}

/**
 * The one-line outcome, derived from the result and nothing else.
 *
 * A JSON object answers with its own flat top-level fields, in the order the
 * server wrote them, skipping nulls and anything nested. That is vendor-neutral
 * by construction: `{ok, command_tag, execution_time_ms}` reads as
 * "ok · GRANT · 522 ms" without this file knowing what a command tag is.
 *
 * Anything that is not a JSON object says what it is and how much of it there
 * is, because "text · 612 lines" is a real answer and the first line of a dump
 * is not.
 */
function outcomeSummary(result: string | null | undefined, status: ToolStatus): string {
  if (status === "running") return "";
  const trimmed = result?.trim();
  if (!trimmed) return status === "failed" ? "Failed" : "";

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "object") continue;
        if (typeof value === "boolean") {
          // A bare `true` says nothing; the FIELD is the fact ("ok").
          if (value) parts.push(key);
          continue;
        }
        if (typeof value === "number") {
          parts.push(
            /(_ms|Ms|millis)$/.test(key)
              ? `${Math.round(value)} ms`
              : `${value} ${key.replace(/_/g, " ")}`,
          );
          continue;
        }
        parts.push(String(value));
        if (parts.length >= 3) break;
      }
      if (parts.length > 0) return parts.slice(0, 3).join(" · ");
    }
    if (Array.isArray(parsed)) {
      return `${parsed.length} ${parsed.length === 1 ? "item" : "items"}`;
    }
  } catch {
    // Not JSON. Fall through to the shape description below.
  }

  const lines = trimmed.split("\n").length;
  const kb = trimmed.length >= 1024 ? `${(trimmed.length / 1024).toFixed(1)} KB` : `${trimmed.length} B`;
  return lines > 1 ? `text · ${lines} lines · ${kb}` : trimmed.slice(0, 80);
}

/** Two letters for the lettered tile, from the server the user named. */
function serverInitials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "MC";
  return words[0].slice(0, 2).toUpperCase();
}

function RunningClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="agw-tool-time">{formatToolDuration(Math.max(0, now - startedAt))}</span>;
}

const McpCallLine: React.FC<{
  call: ToolCall;
  initials: string;
  isActivelyStreaming: boolean;
  remote: boolean;
  /** Named in the delivery line, so the open card can be read on its own. */
  serverName: string;
  transportLabel: string;
  autoApproved: boolean;
}> = ({ call, initials, isActivelyStreaming, remote, serverName, transportLabel, autoApproved }) => {
  const [open, setOpen] = useState(false);
  const status = toolStatus(call, isActivelyStreaming);
  const preparing = status === "running" && call.startedAt == null;

  const args = useMemo(() => {
    if (!call.arguments) return null;
    try {
      const value: unknown = JSON.parse(call.arguments);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Arguments still streaming. The row is drawn either way.
    }
    return null;
  }, [call.arguments]);

  const { chips, payload } = useMemo(() => splitRequest(args), [args]);
  const parsedResult = useMemo(
    () => parseToolResult(call.name, args ?? {}, call.result),
    [call.name, args, call.result],
  );
  const summary = useMemo(() => outcomeSummary(call.result, status), [call.result, status]);
  const label = useMemo(() => mcpOperationLabel(call.name), [call.name]);
  const hasDetail = chips.length > 0 || payload !== null || Boolean(call.result);

  return (
    <div className="agw-tool-card" data-status={status}>
      <button
        type="button"
        className="agw-tool-head"
        aria-expanded={open}
        onClick={() => hasDetail && setOpen((value) => !value)}
      >
        <span className={`agw-tool-dot agw-tool-dot-${status}`}>
          {status === "done" && <AgentIcon name="check" size={13} strokeWidth={2.6} />}
          {status === "failed" && <AgentIcon name="close" size={13} strokeWidth={2.6} />}
        </span>
        <span className="agw-mcp-tile" data-row="" data-remote={remote ? "" : undefined}>
          {initials}
        </span>
        <span className="agw-mcp-op" title={parseMcpToolName(call.name)?.originalToolName ?? call.name}>
          {label}
        </span>
        {status === "running" ? (
          <span className="agw-tool-summary agw-shimmer">
            {preparing ? "Preparing…" : "Waiting for the server…"}
          </span>
        ) : (
          summary && <span className="agw-tool-summary">{summary}</span>
        )}
        {status === "running" && call.startedAt != null ? (
          <RunningClock startedAt={call.startedAt} />
        ) : (
          status !== "running" &&
          typeof call.durationMs === "number" &&
          call.durationMs >= 500 && (
            <span className="agw-tool-time">{formatToolDuration(call.durationMs)}</span>
          )
        )}
        <span style={{ flex: 1 }} />
        {hasDetail && (
          <span
            style={{
              color: "var(--agw-text-subtle)",
              display: "inline-flex",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          >
            <AgentIcon name="chevron-down" size={14} />
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-tool-body">
              {chips.length > 0 && (
                <div className="agw-tool-args">
                  {chips.map(([key, value]) => (
                    <span key={key} className="agw-tool-arg">
                      <span style={{ opacity: 0.6 }}>{key}:</span> {value}
                    </span>
                  ))}
                </div>
              )}

              {payload && (
                <div className="agw-rv">
                  <div className="agw-rv-head">
                    <span className="agw-rv-title-file">{payload.key}</span>
                    <span style={{ flex: 1 }} />
                    <span className="agw-rv-stats">
                      <span>{payload.text.split("\n").length} lines</span>
                    </span>
                  </div>
                  {/* `ToolCode` paints `.agw-tool-result` — the same capped,
                      internally scrolling <pre> a file read lands in, with the
                      same syntax highlighting and the same bottom scroll fade. */}
                  <ToolCode code={payload.text} path={payload.path} />
                  {payload.truncated && (
                    <div className="agw-rv-trunc-note" role="note">
                      Showing the beginning — the full value was too large to render here.
                    </div>
                  )}
                </div>
              )}

              {call.result && <ToolResultView parsed={parsedResult} />}

              {/* Where it went. The only place in the transcript that says a
                  payload left this machine, and whether anyone was asked. */}
              <div className="agw-mcp-deliver">
                <span>
                  Sent to <b>{serverName}</b>
                </span>
                <span className="agw-mcp-deliver-dot" aria-hidden />
                <span>{transportLabel}</span>
                {autoApproved && (
                  <>
                    <span className="agw-mcp-deliver-dot" aria-hidden />
                    <span>ran on auto-approve</span>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const McpServerLane: React.FC<{
  calls: ToolCall[];
  isActivelyStreaming?: boolean;
}> = ({ calls, isActivelyStreaming = false }) => {
  // Subscribe, so a lane rendered before the MCP config loads gains the
  // server's real name and transport the moment they arrive.
  const servers = useMcpStore((state) => state.servers);

  const first = calls[0];
  const resolved = first ? mcpCallForCard(first) : null;
  const parsed = resolved ? parseMcpToolName(resolved.name) : null;
  const server = parsed
    ? servers.find((candidate) => candidate.config.id === parsed.serverId)
    : undefined;

  // A server the user has since removed keeps the id the call was made with.
  // Inventing a friendly name for it would claim knowledge Aurora no longer has.
  const serverName = server?.config.name ?? parsed?.serverName ?? "MCP server";
  const transport = server?.config.transport;
  const remote = transport === "sse" || transport === "http";
  const transportLabel = !transport
    ? "server no longer connected"
    : remote
      ? "remote, left this machine"
      : "stdio, on this machine";
  const autoApproved = server?.config.autoApprove ?? false;
  const initials = serverInitials(serverName);

  const totalMs = calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);

  return (
    <div className="agw-mcp-lane">
      <div className="agw-mcp-lane-head">
        <span className="agw-mcp-tile" data-remote={remote ? "" : undefined}>
          {initials}
        </span>
        <span className="agw-mcp-lane-name" title={serverName}>
          {serverName}
        </span>
        <span className="agw-mcp-lane-rule" aria-hidden />
        <span className="agw-mcp-lane-meta">
          <span>{transportLabel}</span>
          <span className="agw-mcp-deliver-dot" aria-hidden />
          <span>
            {calls.length} {calls.length === 1 ? "call" : "calls"}
          </span>
          {totalMs >= 500 && (
            <>
              <span className="agw-mcp-deliver-dot" aria-hidden />
              <span>{formatToolDuration(totalMs)}</span>
            </>
          )}
        </span>
      </div>
      <div
        className="agw-mcp-lane-rows"
        data-scroll={calls.length >= LANE_SCROLL_MIN_CALLS ? "" : undefined}
      >
        {calls.map((call) => (
          <McpCallLine
            key={call.id}
            call={call}
            initials={initials}
            isActivelyStreaming={isActivelyStreaming}
            remote={remote}
            serverName={serverName}
            transportLabel={transportLabel}
            autoApproved={autoApproved}
          />
        ))}
      </div>
    </div>
  );
};
