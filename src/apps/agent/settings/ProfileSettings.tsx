/**
 * Agent Window — Profile: a local usage summary. A header with four facts
 * (billed tokens, cache reads, requests, cost at list prices), the activity
 * chart beside the weekday × hour rhythm, one ledger card switching between
 * Models, Providers, Projects and Tool calls, and a strip saying where the
 * total comes from. Everything comes from the permanent usage ledger through
 * `usage_stats_get`; nothing is uploaded.
 *
 * Design: `Documents/aurora-profile-v2-designs.html` (owner's pick,
 * 2026-10-24), built from the best part of each variant in
 * `aurora-profile-designs.html`. It replaced top-six panels with a modal for
 * the full list; the full list now scrolls inside its own card.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { auroraInvoke, auroraListen } from "@/kernel/lib/ipc/runtime";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import { AgwButton, AgwSegmented } from "./primitives";
import {
  buildBars,
  cacheHitRate,
  computeStreaks,
  fmtCount,
  fmtUsd,
  modelRows,
  monthPace,
  projectRows,
  providerGroups,
  type ChartMetric,
  type ChartRange,
  type UsageStats,
} from "./profile/profile-data";
import { UsageChart } from "./profile/UsageChart";
import { UsageLedger } from "./profile/UsageLedger";
import { UsageRhythm } from "./profile/UsageRhythm";
import { renderShareCard } from "./profile/share-card";

interface Fact {
  label: string;
  aside: string;
  value: string;
  sub: React.ReactNode;
  /** 0–100, drawn as the thin meter under the fact. */
  meter: number;
  tone?: "accent" | "added";
  /** Short label for the exported image. */
  short: string;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export const ProfileSettings: React.FC = () => {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ChartRange>("days");
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const [exportState, setExportState] = useState<"idle" | "done" | "failed">("idle");
  const models = useAgentSettingsStore((s) => s.models);
  const providers = useAgentSettingsStore((s) => s.providers);
  const rootRef = useRef<HTMLDivElement>(null);
  const exportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
      clearTimeout(exportTimer.current);
      unlisten?.();
      window.removeEventListener("focus", scheduleRefresh);
    };
  }, []);

  const days = useMemo(() => stats?.days ?? [], [stats]);
  const streaks = useMemo(() => computeStreaks(days), [days]);
  const pace = useMemo(() => monthPace(days), [days]);
  const bars = useMemo(() => buildBars(days, range), [days, range]);
  const modelList = useMemo(() => modelRows(stats?.models ?? [], models, providers), [stats, models, providers]);
  const providerList = useMemo(
    () => providerGroups(stats?.requestsByProvider ?? [], providers, models),
    [stats, providers, models],
  );
  const projectList = useMemo(() => projectRows(stats?.projects ?? []), [stats]);

  // A failed refresh keeps what is already on screen and says so above it;
  // only a first read that fails has nothing to show.
  if (error && !stats) {
    return (
      <div className="agw-set-wide">
        <div className="agw-set-notice" data-tone="warning">
          Usage stats are unavailable right now: {error}
        </div>
      </div>
    );
  }

  const input = stats?.lifetimeInputTokens ?? 0;
  const output = stats?.lifetimeOutputTokens ?? 0;
  const cache = stats?.lifetimeCacheReadTokens ?? 0;
  const billed = input + output;
  const requests = stats?.totalRequests ?? 0;
  const cost = stats?.cost;
  const priced = cost?.pricedRequests ?? 0;
  const hit = cacheHitRate(cache, input);
  const dash = "—";

  const facts: Fact[] = [
    {
      label: "Billed tokens",
      aside: stats ? `${pct(input, billed)}% input` : "",
      value: stats ? formatTokens(billed) : dash,
      sub: <><b>{formatTokens(input)}</b> input · <b>{formatTokens(output)}</b> output</>,
      meter: pct(input, billed),
      short: "Tokens",
    },
    {
      label: "Cache reads",
      aside: stats ? `${hit}% hit` : "",
      value: stats ? formatTokens(cache) : dash,
      sub: input > 0 ? <><b>{(cache / input).toFixed(1)}×</b> your billed input, read from cache</> : "Nothing read from cache yet",
      meter: hit,
      tone: "added",
      short: "Cache reads",
    },
    {
      label: "Requests",
      aside: stats && stats.totalThreads > 0 ? `${fmtCount(requests / stats.totalThreads)} per chat` : "",
      value: stats ? fmtCount(requests) : dash,
      sub: (
        <>
          {pace.monthName}: <b>{fmtCount(pace.requests)}</b>
          {pace.change != null && (
            <> · <span className="agw-profile-delta" data-up={pace.change >= 0 ? "" : undefined}>
              {pace.change >= 0 ? "+" : "−"}{Math.abs(pace.change)}%
            </span> vs {pace.prevName} 1–{pace.dayOfMonth}</>
          )}
        </>
      ),
      meter: pct(pace.requests, Math.max(pace.requests, pace.prevRequests)),
      short: "Requests",
    },
    {
      label: "Cost at list prices",
      aside: stats && priced > 0 ? `${pct(priced, requests)}% priced` : "",
      value: stats ? (priced > 0 ? fmtUsd(cost!.usd) : dash) : dash,
      sub:
        priced > 0 ? (
          <><b>{fmtCount(priced)}</b> of {fmtCount(requests)} requests have a price</>
        ) : (
          "Set prices on your models to see cost"
        ),
      meter: pct(priced, requests),
      short: "List price",
    },
  ];
  const removed = providerList.removed;
  const unattributed = stats?.unattributed;

  const exportImage = async () => {
    if (!stats || !rootRef.current) return;
    clearTimeout(exportTimer.current);
    try {
      const blob = await renderShareCard(rootRef.current, {
        userName: stats.userName,
        facts: facts.map((f) => [f.value, f.short]),
        bars: buildBars(days, "days"),
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setExportState("done");
    } catch (err) {
      console.warn("[Profile] Copy as image failed", err);
      setExportState("failed");
    }
    exportTimer.current = setTimeout(() => setExportState("idle"), 2500);
  };

  const since = days[0] ? new Date(`${days[0].date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;

  return (
    <div className="agw-set-wide agw-profile" ref={rootRef}>
      {error && (
        <div className="agw-set-notice" data-tone="warning">
          Couldn't refresh usage stats: {error}. Showing the last read.
        </div>
      )}

      <section className="agw-profile-card agw-profile-summary" aria-label="Summary">
        <div className="agw-profile-head">
          <span className="agw-profile-avatar" aria-hidden>
            {(stats?.userName ?? "?").trim().charAt(0).toUpperCase()}
          </span>
          <div className="agw-profile-head-titles">
            <div className="agw-profile-name-line">{stats?.userName ?? "…"}</div>
            <div className="agw-profile-sub">
              {since && <>Since {since} · </>}
              <b>{fmtCount(days.length)}</b> active days · <b>{fmtCount(stats?.totalThreads ?? 0)}</b> chats ·{" "}
              <b>{streaks.current}</b>-day streak{streaks.longest > streaks.current && <>, longest {streaks.longest}</>}
            </div>
          </div>
          <AgwButton icon="image" onClick={() => void exportImage()} disabled={!stats}>
            {exportState === "done" ? "Copied to clipboard" : exportState === "failed" ? "Copy failed" : "Copy as image"}
          </AgwButton>
        </div>
        <div className="agw-profile-facts">
          {facts.map((fact) => (
            <div key={fact.label} className="agw-profile-fact">
              <div className="agw-profile-fact-label">
                <span>{fact.label}</span>
                <span>{fact.aside}</span>
              </div>
              <div className="agw-profile-fact-value">{fact.value}</div>
              <div className="agw-profile-fact-sub">{stats ? fact.sub : " "}</div>
              <div className="agw-profile-meter" aria-hidden>
                <i data-tone={fact.tone ?? "accent"} style={{ width: `${fact.meter}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="agw-profile-card agw-profile-activity" aria-label="Activity">
        <div className="agw-profile-activity-main">
          <header className="agw-profile-card-head">
            <div>
              <h3>Activity</h3>
              <p>Every day in the range is drawn, quiet ones too. Includes deleted chats.</p>
            </div>
            <div className="agw-profile-card-tools">
              <AgwSegmented<ChartMetric>
                ariaLabel="Measure"
                value={metric}
                options={[
                  { value: "tokens", label: "Billed tokens" },
                  { value: "cache", label: "Cache reads" },
                  { value: "requests", label: "Requests" },
                ]}
                onChange={setMetric}
              />
              <AgwSegmented<ChartRange>
                ariaLabel="Range"
                value={range}
                options={[
                  { value: "days", label: "30 days" },
                  { value: "weeks", label: "26 weeks" },
                  { value: "year", label: "Year" },
                ]}
                onChange={setRange}
              />
            </div>
          </header>
          <UsageChart bars={bars} range={range} metric={metric} />
        </div>
        <UsageRhythm grid={stats?.hourOfWeek ?? []} />
      </section>

      <UsageLedger
        models={modelList}
        providers={providerList}
        projects={projectList}
        tools={stats?.topTools ?? []}
        totalRequests={requests}
        totalTokens={billed}
      />

      {billed > 0 && (
        <section className="agw-profile-card agw-profile-sources" aria-label="Where the total comes from">
          <div>
            <h3>Where {formatTokens(billed)} comes from</h3>
            <p>Every billed token counts in the totals and the chart.</p>
          </div>
          <div>
            <div className="agw-profile-sources-bar" aria-hidden>
              <i data-part="known" style={{ width: `${((billed - (unattributed?.tokens ?? 0)) / billed) * 100}%` }} />
              {(unattributed?.tokens ?? 0) > 0 && <i data-part="unknown" />}
            </div>
            <div className="agw-profile-sources-key">
              <span><i data-part="known" />With a recorded model <b>{formatTokens(billed - (unattributed?.tokens ?? 0))}</b> · in the lists</span>
              {unattributed && unattributed.requests > 0 && (
                <span>
                  <i data-part="unknown" />Before Aurora saved which model answered{" "}
                  <b>{formatTokens(unattributed.tokens)}</b> · {fmtCount(unattributed.requests)} requests
                </span>
              )}
              {removed.count > 0 && (
                <span>
                  <i data-part="removed" />{removed.count} removed {removed.count === 1 ? "provider" : "providers"}{" "}
                  <b>{fmtCount(removed.requests)}</b> requests · last under Providers
                </span>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
