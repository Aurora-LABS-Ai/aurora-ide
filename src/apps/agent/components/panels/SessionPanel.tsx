/**
 * Agent Window — one conversation's details [view].
 *
 * Opened from a chat row's context menu in the rail ("Conversation details"),
 * as a dock tab beside Files and Review — the same container `ProjectPanel`
 * uses, because this is the same idea one level down.
 *
 * ## The turn timeline leads
 *
 * Chosen from `Documents/aurora-session-details-designs.html` (variant 04). One
 * bar per turn, height by duration, so the SHAPE of the session is the first
 * thing visible: where it got slow, where failures clustered, where compaction
 * hit. The table-shaped variants answer "how many"; only this one answers "when
 * did this go wrong", which is the question you open this panel with.
 *
 * Every bar is hoverable and carries its own numbers, which is also why this is
 * a panel and not a tooltip — you cannot hover a bar inside a hover card.
 *
 * ## Context is a MAX, never a sum
 *
 * `contextTokens` per turn is the biggest single prompt that turn sent, not the
 * sum of its requests. Every request in a turn re-sends the whole prefix, so
 * summing them multiplies the conversation by its own length and produces a
 * number that means nothing. The max is what the model actually held, which is
 * what makes the context line climb across a conversation and drop at a
 * compaction.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import {
  formatCost,
  formatTokens,
  formatTurnDuration,
  getConversationStats,
  type ConversationStats,
  type TurnStat,
} from "@/apps/agent/services/workspace/conversation-stats";

/** Bars thinner than this are unreadable and unhoverable. */
const MIN_BAR_PX = 3;

function whenLabel(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const day = Math.floor(diff / 86_400_000);
  if (day < 30) return `${day}d ago`;
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

const Row: React.FC<{
  k: string;
  v: React.ReactNode;
  tone?: "good" | "bad" | "warn";
  title?: string;
}> = ({ k, v, tone, title }) => (
  <div className="agw-sess-kv" title={title}>
    <span className="agw-sess-k">{k}</span>
    <span className="agw-sess-v" data-tone={tone}>
      {v}
    </span>
  </div>
);

export const SessionPanel: React.FC<{ threadId: string }> = ({ threadId }) => {
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<TurnStat | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await getConversationStats(threadId));
    } catch (e) {
      // The thread can be deleted while its tab is open. Say so rather than
      // leaving the panel on a spinner nothing will ever resolve.
      setError(e instanceof Error ? e.message : "Couldn't read that conversation.");
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Memoised, not `stats?.turnStats ?? []`: the bare fallback builds a fresh
  // array on every render, so the two maxima below would recompute on every
  // pointer move across the timeline.
  const turns = useMemo(() => stats?.turnStats ?? [], [stats]);

  // Bar heights are relative to the LONGEST turn in this conversation, so a
  // short session is not a row of stumps and a long one is not clipped. The
  // scale is therefore per-conversation and the axis is deliberately unlabelled
  // — the legend names the longest instead, which is the only absolute anyone
  // reads off it.
  const maxDuration = useMemo(
    () => turns.reduce((m, t) => Math.max(m, t.durationMs), 0),
    [turns],
  );
  const maxContext = useMemo(
    () => turns.reduce((m, t) => Math.max(m, t.contextTokens), 0),
    [turns],
  );

  // What the readout rests on when nothing is being pointed at. The longest
  // turn, because the heading already says the tallest bar is the longest —
  // so the box opens on the turn the eye has already landed on, instead of on
  // an instruction telling you to point at it.
  const longest = useMemo(
    () => turns.reduce<TurnStat | null>((best, t) => (!best || t.durationMs > best.durationMs ? t : best), null),
    [turns],
  );

  if (loading) {
    return <div className="agw-sess agw-sess-note">Reading the conversation…</div>;
  }
  if (error || !stats) {
    return (
      <div className="agw-sess agw-sess-note">
        <p>{error ?? "Nothing to show."}</p>
        <button type="button" className="agw-set-btn" onClick={() => void load()}>
          <AgentIcon name="retry" size={13} />
          Try again
        </button>
      </div>
    );
  }

  // Pointing at a bar wins; letting go falls back to the longest turn.
  const shown = hovered ?? longest;

  const successPct =
    stats.toolCalls > 0 ? (stats.toolSucceeded / stats.toolCalls) * 100 : 0;
  const failPct = stats.toolCalls > 0 ? (stats.toolFailed / stats.toolCalls) * 100 : 0;
  const unresolvedPct =
    stats.toolCalls > 0 ? (stats.toolUnresolved / stats.toolCalls) * 100 : 0;

  return (
    <div className="agw-sess agw-scroll">
      <header className="agw-sess-head">
        <h2 className="agw-sess-title">{stats.title || "New Chat"}</h2>
        <p className="agw-sess-sub">
          {[
            stats.workspaceRoot?.split(/[\\/]/).filter(Boolean).pop(),
            stats.createdAt ? `started ${whenLabel(stats.createdAt)}` : null,
            stats.updatedAt ? `last active ${whenLabel(stats.updatedAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      {/* ── Turn timeline ────────────────────────────────────────────── */}
      <section className="agw-sess-section">
        <h3 className="agw-sess-h">
          {stats.turns} turn{stats.turns === 1 ? "" : "s"}
          <span className="agw-sess-h-note">tallest is the longest</span>
        </h3>

        {turns.length === 0 ? (
          <p className="agw-sess-empty">Nothing has run in this conversation yet.</p>
        ) : (
          <>
            {/* No `role="img"` here: it makes every child presentational, which
                hid the bars — each a focusable button with its own label — from
                assistive tech entirely. The group keeps the summary instead. */}
            <div
              className="agw-sess-strip"
              role="group"
              aria-label={`${stats.turns} turns, ${stats.toolFailed} with a failed tool call`}
              onPointerLeave={() => setHovered(null)}
            >
              {turns.map((t) => {
                const pct = maxDuration > 0 ? (t.durationMs / maxDuration) * 100 : 0;
                return (
                  <button
                    key={t.index}
                    type="button"
                    className="agw-sess-bar"
                    data-fail={t.failedCalls > 0 || undefined}
                    data-longest={
                      t.durationMs === maxDuration && maxDuration > 0 ? "" : undefined
                    }
                    data-compacted={t.compacted || undefined}
                    data-on={hovered?.index === t.index || undefined}
                    style={{ height: `max(${MIN_BAR_PX}px, ${pct}%)` }}
                    onPointerEnter={() => setHovered(t)}
                    onFocus={() => setHovered(t)}
                    aria-label={`Turn ${t.index}, ${formatTurnDuration(t.durationMs)}`}
                  />
                );
              })}
            </div>

            {/* The readout sits UNDER the strip rather than floating over it:
                a tooltip would cover the neighbouring bars you are comparing
                against, which is the entire reason to look at a timeline. */}
            {shown && (
              <div className="agw-sess-readout">
                <div className="agw-sess-readout-head">
                  <span className="agw-sess-readout-n">Turn {shown.index}</span>
                  <span className="agw-sess-readout-dur">
                    {formatTurnDuration(shown.durationMs)}
                  </span>
                  {shown.model && (
                    <span className="agw-sess-readout-model">{shown.model}</span>
                  )}
                </div>
                {shown.prompt && <p className="agw-sess-readout-prompt">{shown.prompt}</p>}
                <div className="agw-sess-readout-facts">
                  <span>
                    {shown.toolCalls} tool call{shown.toolCalls === 1 ? "" : "s"}
                  </span>
                  {shown.failedCalls > 0 && (
                    <span data-tone="bad">{shown.failedCalls} failed</span>
                  )}
                  {shown.requests > 0 && (
                    <span>
                      {shown.requests} request{shown.requests === 1 ? "" : "s"}
                    </span>
                  )}
                  {shown.thinkingMs > 0 && (
                    <span>{formatTurnDuration(shown.thinkingMs)} thinking</span>
                  )}
                  {shown.contextTokens > 0 && (
                    <span title="The largest prompt this turn sent">
                      {formatTokens(shown.contextTokens)} context
                    </span>
                  )}
                  {shown.outputTokens > 0 && (
                    <span>{formatTokens(shown.outputTokens)} out</span>
                  )}
                  {shown.cacheReadTokens > 0 && (
                    <span title="Prefix served from cache">
                      {formatTokens(shown.cacheReadTokens)} cached
                    </span>
                  )}
                  {shown.cacheWriteTokens > 0 && (
                    <span title="Prefix written to cache — this turn rebuilt it">
                      {formatTokens(shown.cacheWriteTokens)} written
                    </span>
                  )}
                  {shown.costUsd !== null && <span>{formatCost(shown.costUsd)}</span>}
                  {shown.compacted && <span data-tone="warn">compacted here</span>}
                  {shown.estimated && (
                    <span data-tone="warn" title="Counts are Aurora's estimate">
                      estimated
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="agw-sess-legend">
              <span>
                <i className="agw-sess-sw" /> turn
              </span>
              <span>
                <i className="agw-sess-sw" data-fail /> had a failed call
              </span>
              <span>
                <i className="agw-sess-sw" data-longest /> longest,{" "}
                {formatTurnDuration(maxDuration)}
              </span>
              {stats.compactions > 0 && (
                <span>
                  <i className="agw-sess-sw" data-compacted /> compaction
                </span>
              )}
            </div>

            {/* Context across the conversation. The same bars, measured on the
                other axis — it is the one trend a totals list cannot show, and
                the drop at a compaction is the clearest evidence that
                compaction did anything at all. */}
            {maxContext > 0 && (
              <>
                <h3 className="agw-sess-h agw-sess-h-tight">
                  Context per turn
                  <span className="agw-sess-h-note">
                    peak {formatTokens(stats.peakContextTokens)}
                    {stats.contextWindow > 0
                      ? ` of ${formatTokens(stats.contextWindow)}`
                      : ""}
                  </span>
                </h3>
                <div className="agw-sess-strip" data-variant="context" aria-hidden>
                  {turns.map((t) => (
                    <span
                      key={t.index}
                      className="agw-sess-bar"
                      data-context=""
                      data-compacted={t.compacted || undefined}
                      data-on={hovered?.index === t.index || undefined}
                      style={{
                        height: `max(${MIN_BAR_PX}px, ${
                          maxContext > 0 ? (t.contextTokens / maxContext) * 100 : 0
                        }%)`,
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* ── Tools ────────────────────────────────────────────────────── */}
      <section className="agw-sess-section">
        <h3 className="agw-sess-h">
          {stats.toolCalls} tool call{stats.toolCalls === 1 ? "" : "s"}
        </h3>
        {stats.toolCalls === 0 ? (
          <p className="agw-sess-empty">No tools were used.</p>
        ) : (
          <>
            <div className="agw-sess-split" aria-hidden>
              <i data-tone="good" style={{ width: `${successPct}%` }} />
              <i data-tone="bad" style={{ width: `${failPct}%` }} />
              <i data-tone="warn" style={{ width: `${unresolvedPct}%` }} />
            </div>
            <p className="agw-sess-splitline">
              <span data-tone="good">{stats.toolSucceeded} succeeded</span>
              {stats.toolFailed > 0 && (
                <span data-tone="bad"> · {stats.toolFailed} failed</span>
              )}
              {stats.toolUnresolved > 0 && (
                <span
                  data-tone="warn"
                  title="The result never came back — a cancelled turn, or a dropped stream"
                >
                  {" "}
                  · {stats.toolUnresolved} unresolved
                </span>
              )}
              {` · ${stats.tools.length} distinct`}
            </p>

            {/* Folded by default. Twenty tool names down the page pushed Work,
                Tokens and Models below the fold on a busy conversation, and the
                split bar above already answers the question most people open
                this for. The breakdown is for the times it does not. */}
            <button
              type="button"
              className="agw-sess-disclose"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((v) => !v)}
            >
              <AgentIcon
                name="chevron-down"
                size={12}
                style={{
                  color: "var(--agw-text-subtle)",
                  flex: "none",
                  transform: toolsOpen ? undefined : "rotate(-90deg)",
                  transition: "transform 0.15s ease",
                }}
              />
              <span>
                {toolsOpen ? "Hide" : "Show"} the {stats.tools.length} tool
                {stats.tools.length === 1 ? "" : "s"} used
              </span>
            </button>

            {toolsOpen && (
              <table className="agw-sess-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th className="r">Calls</th>
                    <th className="r">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.tools.map((t) => (
                    <tr key={t.name}>
                      <td className="agw-sess-tool">{t.name}</td>
                      <td className="r">{t.calls}</td>
                      <td className="r" data-tone={t.failed > 0 ? "bad" : undefined}>
                        {t.failed > 0 ? t.failed : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      {/* ── Work ─────────────────────────────────────────────────────── */}
      <section className="agw-sess-section">
        <h3 className="agw-sess-h">Work</h3>
        <Row
          k="Agent working"
          v={formatTurnDuration(stats.activeMs)}
          title="Summed turn durations — not wall-clock since the chat opened"
        />
        <Row k="Longest turn" v={formatTurnDuration(stats.longestTurnMs)} />
        {stats.thinkingMs > 0 && (
          <Row k="Thinking" v={formatTurnDuration(stats.thinkingMs)} />
        )}
        <Row k="Open for" v={formatTurnDuration(stats.spanMs)} />
        <Row k="Messages" v={stats.messages} />
        {stats.compactions > 0 && (
          <Row k="Compactions" v={stats.compactions} tone="warn" />
        )}
      </section>

      {/* ── Tokens ───────────────────────────────────────────────────── */}
      <section className="agw-sess-section">
        <h3 className="agw-sess-h">
          Tokens
          {stats.estimatedRequests > 0 && (
            <span
              className="agw-sess-h-note"
              title="Some requests had no provider usage, so Aurora counted them itself"
            >
              {stats.estimatedRequests} of {stats.requests} estimated
            </span>
          )}
        </h3>
        <Row k="Input" v={formatTokens(stats.inputTokens)} />
        <Row k="Output" v={formatTokens(stats.outputTokens)} />
        <Row
          k="Total"
          v={formatTokens(stats.totalTokens)}
          title="Input plus output. Cache is counted separately below, as it is billed separately."
        />
        <Row
          k="Cache read"
          v={formatTokens(stats.cacheReadTokens)}
          tone="good"
          title="Prefix served from cache instead of re-sent"
        />
        <Row
          k="Cache written"
          v={formatTokens(stats.cacheWriteTokens)}
          title="Prefix written into the cache — a turn that rebuilt it rather than re-reading it"
        />
        <Row k="Requests" v={stats.requests} />
        <Row
          k="Peak context"
          v={
            stats.contextWindow > 0
              ? `${formatTokens(stats.peakContextTokens)} of ${formatTokens(stats.contextWindow)}`
              : formatTokens(stats.peakContextTokens)
          }
          title="The largest single prompt the model was handed in this conversation"
        />
        {/* Silence rather than "$0.00" when nothing reported a cost — a
            provider that never reports money is not a free one. */}
        {stats.costUsd !== null && (
          <Row
            k="Cost"
            v={
              stats.costReportedRequests < stats.requests
                ? `${formatCost(stats.costUsd)} (partial)`
                : formatCost(stats.costUsd)
            }
            title={
              stats.costReportedRequests < stats.requests
                ? `Only ${stats.costReportedRequests} of ${stats.requests} requests reported a cost`
                : "As reported by the provider"
            }
          />
        )}
      </section>

      {/* ── Models ───────────────────────────────────────────────────── */}
      {stats.models.length > 0 && (
        <section className="agw-sess-section">
          <h3 className="agw-sess-h">
            Model{stats.models.length === 1 ? "" : "s"}
          </h3>
          {stats.models.map((m) => (
            <Row
              key={m.name}
              k={m.name}
              v={`${m.requests} request${m.requests === 1 ? "" : "s"} · ${formatTokens(
                m.inputTokens + m.outputTokens,
              )}`}
              title={`in ${formatTokens(m.inputTokens)} · out ${formatTokens(
                m.outputTokens,
              )} · cache read ${formatTokens(m.cacheReadTokens)} · written ${formatTokens(
                m.cacheWriteTokens,
              )}`}
            />
          ))}
        </section>
      )}

      <div className="agw-sess-foot">
        <button type="button" className="agw-set-btn" onClick={() => void load()}>
          <AgentIcon name="retry" size={13} />
          Refresh
        </button>
      </div>
    </div>
  );
};
