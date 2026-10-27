/**
 * Profile activity: one bar per day or week at its true height, or the year
 * as one square per day. Probe: `Documents/aurora-profile-v2-designs.html`.
 *
 * Bars replaced a smoothed area curve whose cubic smoothing overshot between
 * points, so quiet days either side of a spike drew as a swell that never
 * happened. Every slot in the range is present (see `buildBars`).
 *
 * The readout line above says what is under the pointer or the keyboard
 * cursor; with nothing picked it states the range's total and peak, so the
 * line always carries a fact rather than an instruction to hover. The stage
 * is ONE tab stop: arrow keys move through the slots (in the year view, left
 * and right move a week, up and down a day), and only keyboard moves are
 * announced, so sweeping the mouse across does not make a screen reader talk.
 */

import React, { useMemo, useState } from "react";

import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import { fmtCount, metricValue, type ChartBar, type ChartMetric, type ChartRange } from "./profile-data";

const date = (key: string) => new Date(`${key}T12:00:00`);
const shortDate = (key: string) => date(key).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtMetric = (metric: ChartMetric, n: number) => (metric === "requests" ? fmtCount(n) : formatTokens(Math.round(n)));

function slotLabel(bar: ChartBar, range: ChartRange): string {
  if (range === "weeks") return `Week of ${shortDate(bar.key)}`;
  return date(bar.key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const Readout: React.FC<{ bar: ChartBar | null; bars: ChartBar[]; range: ChartRange; metric: ChartMetric }> = ({
  bar,
  bars,
  range,
  metric,
}) => {
  if (bar) {
    if (bar.requests === 0) {
      return <span><b>{slotLabel(bar, range)}</b> · no activity</span>;
    }
    return (
      <>
        <span>
          <b>{slotLabel(bar, range)}</b> · {formatTokens(bar.tokens)} billed ({formatTokens(bar.inputTokens)} in ·{" "}
          {formatTokens(bar.outputTokens)} out)
        </span>
        <span>
          {formatTokens(bar.cacheReadTokens)} cache · <b>{fmtCount(bar.requests)}</b> requests
        </span>
      </>
    );
  }
  const active = bars.filter((b) => b.requests > 0);
  if (active.length === 0) return <span>No activity in this range</span>;
  const peak = active.reduce((best, b) => (metricValue(b, metric) > metricValue(best, metric) ? b : best));
  const total = (pick: (b: ChartBar) => number) => bars.reduce((sum, b) => sum + pick(b), 0);
  const span = range === "days" ? "Last 30 days" : range === "weeks" ? "Last 26 weeks" : "Last 52 weeks";
  return (
    <>
      <span>
        {span} · <b>{formatTokens(total((b) => b.tokens))}</b> billed · <b>{formatTokens(total((b) => b.cacheReadTokens))}</b>{" "}
        cache · <b>{fmtCount(total((b) => b.requests))}</b> requests
        {range === "year" && <> · {fmtCount(active.length)} active days</>}
      </span>
      <span>
        {range === "year" ? "Busiest day" : "Peak"} <b>{fmtMetric(metric, metricValue(peak, metric))}</b> ·{" "}
        {range === "weeks" ? "week of " : ""}
        {shortDate(peak.key)}
      </span>
    </>
  );
};

const Bars: React.FC<{ bars: ChartBar[]; range: ChartRange; metric: ChartMetric; active: number | null; onPoint: (i: number) => void }> = ({
  bars,
  range,
  metric,
  active,
  onPoint,
}) => {
  const max = Math.max(1, ...bars.map((b) => metricValue(b, metric)));
  const avg = bars.reduce((sum, b) => sum + metricValue(b, metric), 0) / Math.max(1, bars.length);
  const third = Math.floor(bars.length / 3);
  return (
    <>
      <div className="agw-profile-bars">
        {avg > 0 && (
          <div className="agw-profile-avg" style={{ bottom: `${(avg / max) * 100}%` }} aria-hidden>
            <span>
              avg {fmtMetric(metric, avg)}/{range === "days" ? "day" : "wk"}
            </span>
          </div>
        )}
        {bars.map((bar, i) => {
          const value = metricValue(bar, metric);
          // Output on top of input, for billed tokens only; a sliver of output
          // stays visible on days that were nearly all input.
          const outShare = metric === "tokens" && bar.tokens > 0 ? Math.max(6, (bar.outputTokens / bar.tokens) * 100) : 0;
          return (
            <span
              key={bar.key}
              className="agw-profile-bar"
              data-empty={value === 0 ? "" : undefined}
              data-active={active === i ? "" : undefined}
              onMouseEnter={() => onPoint(i)}
            >
              <span className="agw-profile-bar-fill" style={{ height: `${Math.max(1.5, (value / max) * 100)}%` }}>
                {outShare > 0 && <span className="agw-profile-bar-out" style={{ height: `${outShare}%` }} />}
                <span className="agw-profile-bar-in" />
              </span>
            </span>
          );
        })}
      </div>
      <div className="agw-profile-axis" aria-hidden>
        <span>{shortDate(bars[0].key)}</span>
        <span>{shortDate(bars[third].key)}</span>
        <span>{shortDate(bars[third * 2].key)}</span>
        <span>{range === "days" ? "Today" : "This week"}</span>
      </div>
      {metric === "tokens" && (
        <div className="agw-profile-legend" aria-hidden>
          <span><i data-part="in" />Input</span>
          <span><i data-part="out" />Output</span>
        </div>
      )}
    </>
  );
};

/** Quartiles of the active days, so one huge day doesn't wash every other out. */
function levels(values: number[]): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
  const cut = [q(0.25), q(0.5), q(0.8)];
  return (v) => (!v ? 0 : v <= cut[0] ? 1 : v <= cut[1] ? 2 : v <= cut[2] ? 3 : 4);
}

const Year: React.FC<{ bars: ChartBar[]; metric: ChartMetric; active: number | null; onPoint: (i: number) => void }> = ({
  bars,
  metric,
  active,
  onPoint,
}) => {
  const level = useMemo(() => levels(bars.map((b) => metricValue(b, metric))), [bars, metric]);
  // Monday-first rows: the first column starts part-way down on that weekday.
  const offset = bars.length > 0 ? (date(bars[0].key).getDay() + 6) % 7 : 0;
  let lastMonth = "";
  const months: React.ReactNode[] = [];
  bars.forEach((bar, i) => {
    const col = Math.floor((i + offset) / 7) + 2;
    const month = date(bar.key).toLocaleDateString(undefined, { month: "short" });
    if (month !== lastMonth && (i + offset) % 7 === 0) {
      lastMonth = month;
      months.push(
        <span key={bar.key} className="agw-profile-year-month" style={{ gridColumn: col }}>
          {month}
        </span>,
      );
    }
  });
  return (
    <>
      <div className="agw-profile-year">
        {[["Mon", 2], ["Wed", 4], ["Fri", 6]].map(([name, row]) => (
          <span key={name} className="agw-profile-year-day" style={{ gridRow: row }} aria-hidden>
            {name}
          </span>
        ))}
        {months}
        {bars.map((bar, i) => (
          <span
            key={bar.key}
            className="agw-profile-cell"
            data-level={level(metricValue(bar, metric))}
            data-active={active === i ? "" : undefined}
            style={{ gridColumn: Math.floor((i + offset) / 7) + 2, gridRow: ((i + offset) % 7) + 2 }}
            onMouseEnter={() => onPoint(i)}
          />
        ))}
      </div>
      <div className="agw-profile-axis" aria-hidden>
        <span>{fmtCount(bars.filter((b) => b.requests > 0).length)} active days in 52 weeks</span>
        <span className="agw-profile-scale">
          Less
          {[0, 1, 2, 3, 4].map((l) => <i key={l} className="agw-profile-cell" data-level={l} />)}
          More
        </span>
      </div>
    </>
  );
};

export const UsageChart: React.FC<{ bars: ChartBar[]; range: ChartRange; metric: ChartMetric }> = ({
  bars,
  range,
  metric,
}) => {
  const [active, setActive] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  // A range or metric switch hands in new bars; a cursor from the old set
  // would point at the wrong slot.
  const [shownFor, setShownFor] = useState(bars);
  if (shownFor !== bars) {
    setShownFor(bars);
    setActive(null);
  }
  const shown = active != null ? bars[active] ?? null : null;
  const step = range === "year" ? 7 : 1;

  const move = (next: number) => {
    const i = Math.min(bars.length - 1, Math.max(0, next));
    setActive(i);
    const bar = bars[i];
    setAnnounce(
      bar.requests
        ? `${slotLabel(bar, range)}: ${formatTokens(bar.tokens)} billed, ${formatTokens(bar.cacheReadTokens)} cache, ${fmtCount(bar.requests)} requests`
        : `${slotLabel(bar, range)}: no activity`,
    );
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const from = active ?? bars.length - 1;
    const delta: Record<string, number> = {
      ArrowLeft: -step,
      ArrowRight: step,
      ...(range === "year" ? { ArrowUp: -1, ArrowDown: 1 } : {}),
      Home: -bars.length,
      End: bars.length,
    };
    if (!(event.key in delta)) return;
    event.preventDefault();
    move(from + delta[event.key]);
  };

  if (bars.length === 0) return null;
  return (
    <div className="agw-profile-chart">
      <div className="agw-profile-readout">
        <Readout bar={shown} bars={bars} range={range} metric={metric} />
      </div>
      <div
        className="agw-profile-stage"
        tabIndex={0}
        role="group"
        aria-label={`${range === "weeks" ? "Weekly" : "Daily"} activity, ${
          range === "days" ? "last 30 days" : range === "weeks" ? "last 26 weeks" : "last 52 weeks"
        }. Arrow keys read each ${range === "weeks" ? "week" : "day"}.`}
        onKeyDown={onKeyDown}
        onFocus={() => active == null && move(bars.length - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={(event) => {
          if (document.activeElement !== event.currentTarget) setActive(null);
        }}
      >
        {range === "year" ? (
          <Year bars={bars} metric={metric} active={active} onPoint={setActive} />
        ) : (
          <Bars bars={bars} range={range} metric={metric} active={active} onPoint={setActive} />
        )}
      </div>
      <span className="agw-sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
};
