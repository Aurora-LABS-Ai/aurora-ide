/**
 * "When you work": requests by weekday and hour as a dot grid, with the four
 * facts it implies underneath. Dot size and opacity both follow the count, so
 * the busy hours read without a legend. Local time, from `hourOfWeek`.
 */

import React from "react";

import { rhythmFacts } from "./profile-data";

const DAYS = Array.from({ length: 7 }, (_, i) =>
  // 2024-01-01 was a Monday.
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }),
);
const hour = (h: number) => new Date(2024, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

export const UsageRhythm: React.FC<{ grid: number[][] }> = ({ grid }) => {
  const facts = rhythmFacts(grid);
  const max = Math.max(1, ...grid.flat());
  return (
    <aside className="agw-profile-rhythm">
      <header>
        <h3>When you work</h3>
        <p>Requests by weekday and hour, local time.</p>
      </header>
      {facts.total === 0 ? (
        <p className="agw-profile-empty">No requests recorded yet.</p>
      ) : (
        <>
          <div
            className="agw-profile-punch"
            role="img"
            aria-label={`Busiest on ${DAYS[facts.topDay]}, around ${hour(facts.topHour)}`}
          >
            {grid.map((row, d) => (
              <React.Fragment key={DAYS[d]}>
                <span className="agw-profile-punch-day">{DAYS[d]}</span>
                {row.map((count, h) => (
                  <span
                    key={h}
                    className="agw-profile-dot"
                    style={
                      count
                        ? { transform: `scale(${(0.25 + 0.75 * Math.sqrt(count / max)).toFixed(2)})`, opacity: (0.35 + 0.65 * (count / max)).toFixed(2) }
                        : { opacity: 0 }
                    }
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
          <div className="agw-profile-punch-axis" aria-hidden>
            <span />
            {[0, 6, 12, 18].map((h) => <span key={h}>{hour(h)}</span>)}
          </div>
          <dl className="agw-profile-rhythm-facts">
            <div><dt>Busiest hour</dt><dd>{hour(facts.topHour)}–{hour((facts.topHour + 1) % 24)}</dd></div>
            <div><dt>Busiest day</dt><dd>{DAYS[facts.topDay]} · {facts.topDayShare}%</dd></div>
            <div><dt>Weekends</dt><dd>{facts.weekendShare}% of requests</dd></div>
            <div><dt>Midnight to 6 AM</dt><dd>{facts.nightShare}%</dd></div>
          </dl>
        </>
      )}
    </aside>
  );
};
