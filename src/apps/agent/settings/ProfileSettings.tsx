/**
 * Agent Window — Profile: a local, private usage summary that fits on about
 * one screen. Four facts, a bar chart, and the top six models and providers
 * side by side; the full lists open in a searchable dialog. Everything comes
 * from the permanent usage ledger through `usage_stats_get`; nothing is
 * uploaded.
 *
 * Design: `Documents/aurora-profile-designs.html`, variant 02 (owner's pick,
 * 2026-10-01). It replaced six stat tiles, a smoothed curve and an unbounded
 * provider list that ran five screens with 26 rows of "Removed provider".
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { auroraInvoke, auroraListen } from "@/kernel/lib/ipc/runtime";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import { AgwButton, AgwSegmented } from "./primitives";
import {
  buildBars,
  computeStreaks,
  fmtCount,
  modelRows,
  monthTotals,
  providerGroups,
  type ChartRange,
  type UsageStats,
} from "./profile/profile-data";
import { UsageBars } from "./profile/UsageBars";
import { RankPanel } from "./profile/UsageRank";
import { renderShareCard } from "./profile/share-card";

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long" });

export const ProfileSettings: React.FC = () => {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ChartRange>("days");
  const [exportState, setExportState] = useState<"idle" | "done" | "failed">("idle");
  const models = useAgentSettingsStore((s) => s.models);
  const providers = useAgentSettingsStore((s) => s.providers);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let running = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      requested = true;
      if (running || !alive) return;
      running = true;
      try {
        do {
          requested = false;
          try {
            const result = await auroraInvoke<UsageStats>("usage_stats_get");
            if (alive) {
              setStats(result);
              setError(null);
            }
          } catch (err) {
            if (alive) setError(err instanceof Error ? err.message : String(err));
          }
        } while (alive && requested);
      } finally {
        running = false;
      }
    };
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    };
    void auroraListen("usage-updated", scheduleRefresh).then((dispose) => {
      if (alive) {
        unlisten = dispose;
        // Cover a usage update between the first read and listener setup.
        scheduleRefresh();
      } else dispose();
    }).catch((err) => {
      console.warn("[Profile] Live usage updates unavailable; refresh on focus remains active", err);
    });
    window.addEventListener("focus", scheduleRefresh);
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
      unlisten?.();
      window.removeEventListener("focus", scheduleRefresh);
    };
  }, []);

  const days = useMemo(() => stats?.days ?? [], [stats]);
  const streaks = useMemo(() => computeStreaks(days), [days]);
  const month = useMemo(() => monthTotals(days), [days]);
  const bars = useMemo(() => buildBars(days, range), [days, range]);
  const modelList = useMemo(() => modelRows(stats?.models ?? [], models), [stats, models]);
  const providerList = useMemo(
    () => providerGroups(stats?.requestsByProvider ?? [], providers),
    [stats, providers],
  );

  if (error) {
    return (
      <div className="agw-set-wide">
        <div className="agw-set-notice" data-tone="warning">
          Usage stats are unavailable right now: {error}
        </div>
      </div>
    );
  }

  const lifetime = stats ? stats.lifetimeInputTokens + stats.lifetimeOutputTokens : 0;
  const facts: Array<{ value: string; label: string }> = [
    { value: stats ? formatTokens(lifetime) : "—", label: "Lifetime tokens" },
    {
      value: stats ? fmtCount(stats.totalRequests) : "—",
      label: stats ? `Requests · ${fmtCount(stats.totalThreads)} chats` : "Requests",
    },
    {
      value: stats ? formatTokens(month.tokens) : "—",
      label: `${MONTH.format(new Date())} · ${fmtCount(month.requests)} requests`,
    },
    {
      value: stats ? `${streaks.current} ${streaks.current === 1 ? "day" : "days"}` : "—",
      label: `Streak · longest ${streaks.longest}`,
    },
  ];
  const removed = providerList.removed;
  const unattributed = stats?.unattributed;

  const exportImage = async () => {
    if (!stats || !rootRef.current) return;
    try {
      const blob = await renderShareCard(rootRef.current, {
        userName: stats.userName,
        facts: facts.map((f) => [f.value, f.label.split(" · ")[0]]),
        bars: buildBars(days, "days"),
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setExportState("done");
    } catch (err) {
      console.warn("[Profile] Export as image failed", err);
      setExportState("failed");
    }
    window.setTimeout(() => setExportState("idle"), 2500);
  };

  return (
    <div className="agw-set-wide agw-profile" ref={rootRef}>
      <div className="agw-profile-head">
        <span className="agw-prov-avatar agw-profile-avatar">
          {(stats?.userName ?? "?").trim().charAt(0).toUpperCase()}
        </span>
        <div className="agw-profile-head-titles">
          <div className="agw-profile-name">{stats?.userName ?? "…"}</div>
          <div className="agw-profile-sub">Local profile · stats never leave this machine</div>
        </div>
        <AgwButton icon="palette" onClick={() => void exportImage()} disabled={!stats}>
          {exportState === "done"
            ? "Copied to clipboard"
            : exportState === "failed"
              ? "Copy failed"
              : "Export as image"}
        </AgwButton>
      </div>

      <div className="agw-profile-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="agw-profile-fact">
            <div className="agw-profile-fact-value">{fact.value}</div>
            <div className="agw-profile-fact-label">{fact.label}</div>
          </div>
        ))}
      </div>

      <section className="agw-profile-activity">
        <header className="agw-profile-activity-head">
          <div>
            <h3>Activity</h3>
            <p>Input and output tokens, including deleted conversations.</p>
          </div>
          <AgwSegmented<ChartRange>
            ariaLabel="Chart range"
            value={range}
            options={[
              { value: "days", label: "30 days" },
              { value: "weeks", label: "26 weeks" },
            ]}
            onChange={setRange}
          />
        </header>
        <UsageBars bars={bars} range={range} />
      </section>

      <div className="agw-profile-panels">
        <RankPanel
          title="Models"
          subtitle="By tokens · share of tokens with a recorded model"
          rows={modelList}
          format={formatTokens}
          noun="models"
          empty="No model activity recorded yet."
        />
        <RankPanel
          title="Providers"
          subtitle="By requests · tokens beside"
          rows={providerList.active}
          format={fmtCount}
          noun="providers"
          empty="No requests recorded yet."
          trailing={
            removed.count > 0
              ? {
                  heading: "Removed providers",
                  row: {
                    id: "removed",
                    label: `${removed.count} removed ${removed.count === 1 ? "provider" : "providers"}`,
                    value: removed.requests,
                    aside: formatTokens(removed.tokens),
                    detail: "names no longer known",
                  },
                }
              : undefined
          }
        />
      </div>

      {((unattributed && unattributed.requests > 0) || removed.count > 0) && (
        <p className="agw-profile-foot">
          {unattributed && unattributed.requests > 0 && (
            <>
              {formatTokens(unattributed.tokens)} tokens ({fmtCount(unattributed.requests)} requests)
              were recorded before Aurora saved which model answered. They count in the totals and
              the chart, not in the lists.{" "}
            </>
          )}
          {removed.count > 0 && (
            <>
              {removed.count} {removed.count === 1 ? "provider" : "providers"} you've removed hold{" "}
              {fmtCount(removed.requests)} requests, grouped at the end of the full provider list.
            </>
          )}
        </p>
      )}
    </div>
  );
};
