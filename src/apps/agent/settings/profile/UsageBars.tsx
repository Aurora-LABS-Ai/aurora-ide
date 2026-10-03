/**
 * Profile activity chart: one bar per day (or week), at its true height.
 *
 * Replaced a smoothed area curve. The cubic smoothing overshot between points,
 * so quiet days either side of a spike drew as a swell that never happened,
 * and missing days were simply not plotted. Bars cannot overshoot, and every
 * slot in the range is present (see `buildBars`).
 *
 * The readout line above the bars says what is under the pointer; with
 * nothing hovered it states the range's peak, so the line always carries a
 * fact rather than an instruction to hover.
 */

import React, { useState } from "react";

import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import { fmtCount, type ChartBar, type ChartRange } from "./profile-data";

const shortDate = (key: string) =>
  new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const slotLabel = (bar: ChartBar, range: ChartRange) =>
  range === "weeks" ? `Week of ${shortDate(bar.key)}` : shortDate(bar.key);

export const UsageBars: React.FC<{ bars: ChartBar[]; range: ChartRange }> = ({ bars, range }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.tokens));
  const peak = bars.reduce<ChartBar | null>((best, b) => (!best || b.tokens > best.tokens ? b : best), null);
  const total = bars.reduce((sum, b) => sum + b.tokens, 0);
  const shown = hovered != null ? bars[hovered] : null;
  const span = range === "days" ? "30 days" : "26 weeks";

  return (
    <div className="agw-profile-chart">
      <div className="agw-profile-readout" aria-live="polite">
        {shown ? (
          <>
            <span>{slotLabel(shown, range)}</span>
            <b>{formatTokens(shown.tokens)} tokens</b>
            <span>{fmtCount(shown.requests)} requests</span>
          </>
        ) : total > 0 && peak ? (
          <>
            <span>Last {span}</span>
            <b>{formatTokens(total)} tokens</b>
            <span>
              Peak {formatTokens(peak.tokens)} · {slotLabel(peak, range)}
            </span>
          </>
        ) : (
          <span>No activity in the last {span}</span>
        )}
      </div>
      <div
        className="agw-profile-bars"
        role="img"
        aria-label={`Tokens per ${range === "days" ? "day" : "week"}, last ${span}`}
        onMouseLeave={() => setHovered(null)}
      >
        {bars.map((bar, i) => (
          <span
            key={bar.key}
            className="agw-profile-bar"
            data-empty={bar.tokens === 0 ? "" : undefined}
            data-active={hovered === i ? "" : undefined}
            onMouseEnter={() => setHovered(i)}
          >
            <span style={{ height: `${(bar.tokens / max) * 100}%` }} />
          </span>
        ))}
      </div>
      {bars.length > 0 && (
        <div className="agw-profile-axis" aria-hidden>
          <span>{shortDate(bars[0].key)}</span>
          <span>{shortDate(bars[Math.floor(bars.length / 2)].key)}</span>
          <span>{range === "days" ? "Today" : "This week"}</span>
        </div>
      )}
    </div>
  );
};
