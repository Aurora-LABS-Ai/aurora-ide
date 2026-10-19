import type { ReactNode } from "react";
import { formatValue } from "./data";
import type { ReportTone, ValueFormat } from "./types";

export interface MetricProps {
  label: string;
  value: number | null;
  format?: ValueFormat;
  previous?: number;
  note?: string;
  tone?: ReportTone;
}

export function Metric({ label, value, format, previous, note, tone = "neutral" }: MetricProps) {
  const change = value !== null && previous !== undefined ? value - previous : null;
  return (
    <div className={`ac-metric ac-tone-${tone}`}>
      <dt className="ac-metric-label">{label}</dt>
      <dd className="ac-metric-value">{formatValue(value, format)}</dd>
      {change !== null && <dd className="ac-metric-change">
        {change > 0 ? "+" : ""}{formatValue(change, format)}
        {previous !== 0 && <> ({formatValue(change / Math.abs(previous!), { style: "percent", digits: 1 })})</>}
        <span> vs previous</span>
      </dd>}
      {note && <dd className="ac-metric-note">{note}</dd>}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <dl className="ac-metric-grid">{children}</dl>;
}
