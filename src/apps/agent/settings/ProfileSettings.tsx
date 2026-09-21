/**
 * Agent Window — Profile / usage stats page (view).
 *
 * Local, private usage dashboard: lifetime token totals, a daily/weekly/
 * cumulative activity chart, streaks, longest task, and most-used tools —
 * all aggregated from the permanent local usage ledger by the Rust
 * `usage_stats_get` command. Nothing is uploaded anywhere.
 *
 * Streak math happens HERE (not in Rust) because "today" belongs to the
 * renderer's timezone at the moment of viewing.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { auroraInvoke, auroraListen } from "@/kernel/lib/ipc/runtime";
import { ActivityChart } from "./ActivityChart";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { AgentIcon } from "../shared/AgentIcon";
import { AgwButton, AgwSegmented } from "./primitives";
import { formatTokens as fmtTokens, prettyModel } from "@/apps/agent/lib/thread/model-label";

interface DayUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
}

/** Exact API-request counts for one model, from `usage_stats_get`. */
interface ModelRequestUsage {
  model: string;
  requests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface ProviderRequestUsage {
  /** Provider ROW id — a UUID for user-added providers, so never rendered raw. */
  providerId: string;
  requests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  threads: number;
  models: ModelRequestUsage[];
}

interface UsageStats {
  totalThreads: number;
  totalMessages: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeCacheReadTokens: number;
  userName: string;
  days: DayUsage[];
  topTools: { name: string; count: number }[];
  topModels: { name: string; threads: number; tokens: number }[];
  requestsByProvider: ProviderRequestUsage[];
  totalRequests: number;
  longestTask: { threadId: string; title: string; durationMs: number } | null;
}

type ChartMode = "daily" | "weekly" | "cumulative";

/** 3417890114 → "3.4B", 141_300_000 → "141.3M", 4520 → "4.5K". */
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Request counts, grouped with separators.
 *
 * Deliberately NOT the `1.2K` token formatter: a request count is a countable
 * thing a person may want to reconcile against a provider dashboard, and
 * rounding 1,247 to "1.2K" makes that impossible. Tokens are estimates at
 * this scale; requests are not.
 */
function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Current streak counts back from today (a quiet today doesn't break it
 * until tomorrow); longest streak is the longest run of consecutive
 * active days anywhere in history.
 */
function computeStreaks(days: DayUsage[]): { current: number; longest: number } {
  if (days.length === 0) return { current: 0, longest: 0 };
  const active = new Set(days.map((d) => d.date));

  let current = 0;
  const cursor = new Date();
  if (!active.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(localDateKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of days) {
    const date = new Date(`${d.date}T12:00:00`);
    if (prev) {
      const gapDays = Math.round((date.getTime() - prev.getTime()) / 86_400_000);
      run = gapDays === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = date;
  }
  return { current, longest };
}

interface Bar {
  label: string;
  value: number;
  /** Assistant turns in this bucket — absent for cumulative view. */
  turns?: number;
}

function buildBars(days: DayUsage[], mode: ChartMode): Bar[] {
  const total = (d: DayUsage) => d.inputTokens + d.outputTokens;
  if (mode === "weekly") {
    // ISO-ish weekly buckets keyed by the Monday of each week.
    const weeks = new Map<string, { value: number; turns: number }>();
    for (const d of days) {
      const date = new Date(`${d.date}T12:00:00`);
      const monday = new Date(date);
      monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      const key = localDateKey(monday);
      const w = weeks.get(key) ?? { value: 0, turns: 0 };
      w.value += total(d);
      w.turns += d.turns;
      weeks.set(key, w);
    }
    return Array.from(weeks, ([label, w]) => ({
      label: `Week of ${label}`,
      value: w.value,
      turns: w.turns,
    }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(-26);
  }

  const recent = days.slice(-60);
  if (mode === "cumulative") {
    // Cumulative includes everything BEFORE the window so the curve
    // starts at the true running total, not zero.
    const windowStart = recent[0]?.date ?? "";
    let sum = days
      .filter((d) => d.date < windowStart)
      .reduce((acc, d) => acc + total(d), 0);
    return recent.map((d) => {
      sum += total(d);
      return { label: d.date, value: sum };
    });
  }
  return recent.map((d) => ({ label: d.date, value: total(d), turns: d.turns }));
}

/** Load the app logo for the share card; resolves null if unavailable. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Render a shareable PNG card (1200×640) of the headline stats + activity
 * chart, colored from the LIVE theme tokens of `themedEl`. Branded with the
 * Aurora icon + wordmark as a bottom-right watermark. Returns a blob.
 */
async function renderShareCard(
  themedEl: HTMLElement,
  stats: UsageStats,
  bars: Bar[],
  extras: { lifetime: number; current: number; longest: number },
): Promise<Blob> {
  const css = getComputedStyle(themedEl);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 640;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  const bg = token("--agw-canvas", "#111");
  const text = token("--agw-text", "#e6e6e6");
  const subtle = token("--agw-text-subtle", "#727272");
  const accent = token("--agw-accent", "#4b9eff");
  const border = token("--agw-border", "#2a2a2a");

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1200, 640);
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 1198, 638);

  const logo = await loadImage("/aurora.png");

  ctx.fillStyle = text;
  ctx.font = "600 34px Inter, 'Segoe UI', sans-serif";
  ctx.fillText(stats.userName, 56, 84);
  ctx.fillStyle = subtle;
  ctx.font = "500 18px Inter, 'Segoe UI', sans-serif";
  ctx.fillText(new Date().toLocaleDateString(), 56, 116);

  const tiles: Array<[string, string]> = [
    [fmtTokens(extras.lifetime), "LIFETIME TOKENS"],
    [String(stats.totalThreads), "CHATS"],
    [`${extras.current}d`, "CURRENT STREAK"],
    [`${extras.longest}d`, "LONGEST STREAK"],
  ];
  tiles.forEach(([value, label], i) => {
    const x = 56 + i * 280;
    ctx.fillStyle = text;
    ctx.font = "650 44px Inter, 'Segoe UI', sans-serif";
    ctx.fillText(value, x, 210);
    ctx.fillStyle = subtle;
    ctx.font = "600 14px Inter, 'Segoe UI', sans-serif";
    ctx.fillText(label, x, 240);
  });

  // Smooth-shaded area curve — the same infographic as the page.
  const pts30 = bars.slice(-30);
  const max = Math.max(1, ...pts30.map((b) => b.value));
  const area = { x: 56, y: 290, w: 1088, h: 250 };
  const px = (i: number) =>
    area.x + (pts30.length > 1 ? (i * area.w) / (pts30.length - 1) : 0);
  const py = (v: number) => area.y + area.h - 20 - (v / max) * (area.h - 44);
  const soft = accent.startsWith("#") && accent.length === 7 ? `${accent}50` : accent;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(px(0), py(pts30[0]?.value ?? 0));
    for (let i = 1; i < pts30.length; i++) {
      const mx = (px(i - 1) + px(i)) / 2;
      ctx.bezierCurveTo(mx, py(pts30[i - 1].value), mx, py(pts30[i].value), px(i), py(pts30[i].value));
    }
  };
  // Gradient area fill.
  const fillGrad = ctx.createLinearGradient(0, area.y, 0, area.y + area.h);
  fillGrad.addColorStop(0, soft);
  fillGrad.addColorStop(1, "transparent");
  trace();
  ctx.lineTo(px(pts30.length - 1), area.y + area.h - 12);
  ctx.lineTo(px(0), area.y + area.h - 12);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();
  // Glow underlay + crisp curve.
  trace();
  ctx.strokeStyle = soft;
  ctx.lineWidth = 8;
  ctx.stroke();
  trace();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = subtle;
  ctx.font = "500 15px Inter, 'Segoe UI', sans-serif";
  ctx.fillText("Token activity — generated locally", 56, 600);

  // Brand watermark, bottom-right: icon + wordmark, the way product share
  // cards sign themselves. Slightly translucent so it reads as a mark, not
  // a caption.
  {
    const wordmark = "Aurora Agent";
    ctx.font = "650 21px Inter, 'Segoe UI', sans-serif";
    const textW = ctx.measureText(wordmark).width;
    const icon = 32;
    const gap = 11;
    const baselineY = 604;
    const startX = 1200 - 56 - (icon + gap + textW);
    ctx.globalAlpha = 0.92;
    if (logo) {
      ctx.drawImage(logo, startX, baselineY - icon + 7, icon, icon);
    }
    ctx.fillStyle = text;
    ctx.fillText(wordmark, startX + icon + gap, baselineY);
    ctx.globalAlpha = 1;
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

export const ProfileSettings: React.FC = () => {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>("daily");
  const [hovered, setHovered] = useState<Bar | null>(null);
  const [exportState, setExportState] = useState<"idle" | "done" | "failed">("idle");
  const [openProviders, setOpenProviders] = useState<Set<string>>(new Set());
  const models = useSettingsStore((s) => s.models);
  const providers = useSettingsStore((s) => s.providers);
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

  const streaks = useMemo(() => computeStreaks(stats?.days ?? []), [stats]);
  /**
   * Resolve each provider ROW id to something a person recognises.
   *
   * The id is a readable slug for built-ins but a generated UUID for anything
   * the user added, so rendering it raw is meaningless half the time — the
   * same mistake the cost card made. A provider that has since been deleted
   * keeps its requests: they were really sent, and dropping them would make
   * the total disagree with the rows under it.
   */
  const providerRows = useMemo(() => {
    return (stats?.requestsByProvider ?? []).map((p) => {
      const known = providers.find((row) => row.id === p.providerId);
      const label = known?.name?.trim()
        ? known.name
        : p.providerId
          ? `Removed provider (${p.providerId.slice(0, 8)}…)`
          : "Unattributed historical usage";
      return { ...p, label };
    });
  }, [stats, providers]);

  const toggleProvider = (id: string) =>
    setOpenProviders((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const bars = useMemo(() => buildBars(stats?.days ?? [], mode), [stats, mode]);
  const peakDay = useMemo(() => {
    let best = 0;
    for (const d of stats?.days ?? []) best = Math.max(best, d.inputTokens + d.outputTokens);
    return best;
  }, [stats]);

  if (error) {
    return (
      <div className="agw-set-wide">
        <div className="agw-set-notice" data-tone="warning">
          Usage stats are unavailable right now: {error}
        </div>
      </div>
    );
  }

  const lifetime = stats
    ? stats.lifetimeInputTokens + stats.lifetimeOutputTokens
    : 0;

  const exportImage = async () => {
    if (!stats || !rootRef.current) return;
    try {
      const blob = await renderShareCard(rootRef.current, stats, buildBars(stats.days, "daily"), {
        lifetime,
        current: streaks.current,
        longest: streaks.longest,
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setExportState("done");
    } catch {
      setExportState("failed");
    }
    window.setTimeout(() => setExportState("idle"), 2500);
  };

  return (
    <div className="agw-set-wide" ref={rootRef}>
      {/* Identity + share */}
      <div className="agw-profile-head">
        <span className="agw-prov-avatar agw-profile-avatar">
          {(stats?.userName ?? "?").trim().charAt(0).toUpperCase()}
        </span>
        <div className="agw-profile-head-titles">
          <div className="agw-profile-name">{stats?.userName ?? "…"}</div>
          <div className="agw-profile-sub">Local profile — stats never leave this machine</div>
        </div>
        <AgwButton icon="palette" onClick={() => void exportImage()} disabled={!stats}>
          {exportState === "done"
            ? "Copied to clipboard"
            : exportState === "failed"
              ? "Copy failed"
              : "Export as image"}
        </AgwButton>
      </div>

      {/* Headline stats */}
      <div className="agw-profile-tiles">
        <StatTile label="Lifetime tokens" value={stats ? fmtTokens(lifetime) : "—"} />
        <StatTile label="Chats" value={stats ? String(stats.totalThreads) : "—"} />
        <StatTile label="Peak day" value={stats ? fmtTokens(peakDay) : "—"} />
        <StatTile
          label="Longest task"
          value={stats?.longestTask ? fmtDuration(stats.longestTask.durationMs) : "—"}
          hint={stats?.longestTask?.title}
        />
        <StatTile label="Current streak" value={stats ? `${streaks.current}d` : "—"} />
        <StatTile label="Longest streak" value={stats ? `${streaks.longest}d` : "—"} />
      </div>

      {/* Token activity */}
      <section className="agw-set-section">
        <header className="agw-profile-chart-head">
          <div>
            <h3 className="agw-set-section-title">Token activity</h3>
            <p className="agw-set-section-desc">
              Input + output tokens across Build and Chat, including deleted conversations.
            </p>
          </div>
          <AgwSegmented<ChartMode>
            ariaLabel="Chart range"
            value={mode}
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "cumulative", label: "Cumulative" },
            ]}
            onChange={setMode}
          />
        </header>
        {/* Live readout of the hovered bar — a real detail line, not a laggy
            native tooltip. Reserved height so the chart never jumps. */}
        <div className="agw-profile-readout" aria-live="polite">
          {hovered ? (
            <>
              <span className="agw-profile-readout-date">{hovered.label}</span>
              <span className="agw-profile-readout-val">{fmtTokens(hovered.value)} tokens</span>
              {hovered.turns != null && (
                <span className="agw-profile-readout-turns">
                  {hovered.turns} {hovered.turns === 1 ? "turn" : "turns"}
                </span>
              )}
            </>
          ) : (
            <span className="agw-profile-readout-hint">Hover the chart for daily detail</span>
          )}
        </div>
        <ActivityChart
          points={bars.slice(mode === "daily" ? -30 : mode === "weekly" ? -26 : -60)}
          hovered={hovered}
          onHover={setHovered}
          formatLabel={(l) =>
            l.startsWith("Week of ")
              ? new Date(`${l.slice(8)}T12:00:00`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              : new Date(`${l}T12:00:00`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
          }
        />
      </section>

      {/* Most used models */}
      <section className="agw-set-section">
        <header className="agw-set-section-head">
          <div className="agw-set-section-title-wrap">
            <span className="agw-set-section-ico">
              <AgentIcon name="providers" size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h3 className="agw-set-section-title">Most used models</h3>
              <p className="agw-set-section-desc">
                By tokens, attributed to the model used for each request.
              </p>
            </div>
          </div>
        </header>
        <div className="agw-profile-tools">
          {(stats?.topModels ?? []).map((m) => {
            const maxModel = Math.max(1, ...(stats?.topModels.map((x) => x.tokens) ?? []));
            return (
              <div key={m.name} className="agw-profile-tool">
                <span className="agw-profile-tool-name" title={m.name}>
                  {m.name ? prettyModel(m.name, models) : "Unattributed historical usage"}
                </span>
                <span className="agw-profile-tool-track">
                  <span
                    className="agw-profile-tool-fill"
                    style={{ width: `${Math.round((m.tokens / maxModel) * 100)}%` }}
                  />
                </span>
                <span className="agw-profile-tool-count">{fmtTokens(m.tokens)}</span>
              </div>
            );
          })}
          {stats && stats.topModels.length === 0 && (
            <div className="agw-prov-empty">No model activity recorded yet.</div>
          )}
        </div>
      </section>

      {/* Requests — the number that maps to a rate limit and a bill. Counted
        * per API CALL, so a turn that used seven tools is eight requests, not
        * one. Provider first because that is how the question gets asked;
        * models expand underneath. Replaced the tool ranking, which was
        * trivia by comparison. */}
      <section className="agw-set-section">
        <header className="agw-set-section-head">
          <div className="agw-set-section-title-wrap">
            <span className="agw-set-section-ico">
              <AgentIcon name="database" size={15} />
            </span>
            <div>
              <h3 className="agw-set-section-title">Requests by provider</h3>
              <p className="agw-set-section-desc">
                {stats ? fmtCount(stats.totalRequests) : "—"} API requests sent in total. One per
                tool step, so a single question is usually many requests.
              </p>
            </div>
          </div>
        </header>
        <div className="agw-profile-providers">
          {providerRows.map((p) => {
            const open = openProviders.has(p.providerId);
            return (
              <div key={p.providerId || "unattributed"} className="agw-profile-provider">
                <button
                  type="button"
                  className="agw-profile-provider-head"
                  aria-expanded={open}
                  onClick={() => toggleProvider(p.providerId)}
                >
                  <AgentIcon
                    name="chevron-down"
                    size={12}
                    style={{
                      color: "var(--agw-text-subtle)",
                      flex: "none",
                      transform: open ? undefined : "rotate(-90deg)",
                      transition: "transform 0.15s ease",
                    }}
                  />
                  <span className="agw-profile-provider-name" title={p.label}>
                    {p.label}
                  </span>
                  <span className="agw-profile-provider-meta">
                    {p.models.length} {p.models.length === 1 ? "model" : "models"}
                  </span>
                  <span className="agw-profile-provider-count">{fmtCount(p.requests)}</span>
                </button>
                {open && (
                  <div className="agw-profile-provider-models">
                    {p.models.map((m) => (
                      <div key={m.model} className="agw-profile-provider-model">
                        <span
                          className="agw-profile-provider-model-name"
                          title={m.model || "unrecorded model"}
                        >
                          {m.model || "unrecorded model"}
                        </span>
                        <span className="agw-profile-provider-model-track">
                          <span
                            className="agw-profile-provider-model-fill"
                            style={{
                              width: `${Math.round((m.requests / Math.max(1, p.requests)) * 100)}%`,
                            }}
                          />
                        </span>
                        <span className="agw-profile-provider-model-count">
                          {fmtCount(m.requests)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {stats && providerRows.length === 0 && (
            <div className="agw-prov-empty">No requests recorded yet.</div>
          )}
        </div>
      </section>
    </div>
  );
};

/**
 * GitHub-style contribution heatmap: 26 weeks × 7 days of rounded cells,
 * intensity-scaled by tokens, month labels underneath, live readout on hover
 * via `onHover`. This is the "Daily" view — denser and more scannable than a
 * bar-per-day, and it makes streaks visible at a glance.
 */
// Retired from the page (user preferred the row design) — kept exported for
// a possible future "year view".
export const Heatmap: React.FC<{
  days: DayUsage[];
  onHover: (bar: Bar | null) => void;
}> = ({ days, onHover }) => {
  const WEEKS = 26;
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const max = useMemo(
    () => Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens)),
    [days],
  );

  const { columns, monthLabels } = useMemo(() => {
    // Align the last column to the current week (Mon-first rows).
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const columns: Array<Array<{ date: string; value: number; turns: number; future: boolean }>> = [];
    const monthLabels: string[] = [];
    let lastMonth = -1;
    for (let w = WEEKS - 1; w >= 0; w--) {
      const col: Array<{ date: string; value: number; turns: number; future: boolean }> = [];
      const colStart = new Date(monday);
      colStart.setDate(monday.getDate() - w * 7);
      for (let d = 0; d < 7; d++) {
        const cell = new Date(colStart);
        cell.setDate(colStart.getDate() + d);
        const key = localDateKey(cell);
        const day = byDate.get(key);
        col.push({
          date: key,
          value: day ? day.inputTokens + day.outputTokens : 0,
          turns: day?.turns ?? 0,
          future: cell > today,
        });
      }
      const month = colStart.getMonth();
      monthLabels.push(month !== lastMonth ? colStart.toLocaleString(undefined, { month: "short" }) : "");
      lastMonth = month;
      columns.push(col);
    }
    return { columns, monthLabels };
  }, [byDate]);

  const level = (value: number) => {
    if (value <= 0) return 0;
    const r = value / max;
    return r > 0.75 ? 4 : r > 0.4 ? 3 : r > 0.15 ? 2 : 1;
  };

  return (
    <div className="agw-heatmap-wrap" onMouseLeave={() => onHover(null)}>
      <div className="agw-heatmap-grid">
        {/* Day-of-week rail — anchors the grid rows. */}
        <div className="agw-heatmap-days" aria-hidden>
          <span>Mon</span>
          <span />
          <span>Wed</span>
          <span />
          <span>Fri</span>
          <span />
          <span>Sun</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="agw-heatmap" role="img" aria-label="Daily token activity heatmap">
            {columns.map((col, i) => (
              <div key={i} className="agw-heatmap-col">
                {col.map((cell) =>
                  cell.future ? (
                    <span key={cell.date} className="agw-heatmap-cell" data-future />
                  ) : (
                    <span
                      key={cell.date}
                      className="agw-heatmap-cell"
                      data-level={level(cell.value)}
                      onMouseEnter={() =>
                        onHover({ label: cell.date, value: cell.value, turns: cell.turns })
                      }
                    />
                  ),
                )}
              </div>
            ))}
          </div>
          <div className="agw-heatmap-months">
            {monthLabels.map((label, i) => (
              <span key={i}>{label}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="agw-heatmap-legend" aria-hidden>
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="agw-heatmap-cell" data-level={l} data-static />
        ))}
        <span>More</span>
      </div>
    </div>
  );
};

const StatTile: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div className="agw-set-tile agw-profile-tile" title={hint}>
    <div className="agw-profile-tile-value">{value}</div>
    <div className="agw-profile-tile-label">{label}</div>
  </div>
);
