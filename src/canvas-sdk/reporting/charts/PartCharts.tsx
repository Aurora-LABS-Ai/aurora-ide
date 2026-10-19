import type React from "react";
import { formatValue } from "../data";
import { markProps, seriesColor, shortLabel, type DrawingProps } from "./drawing";

export function PartChart(props: DrawingProps) {
  const { spec, points, series } = props;
  const field = series[0];
  if (!field) return null;
  const values = points.map((point) => point.values[field.index] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const maximum = Math.max(1, ...values);
  const width = Math.max(props.width, spec.kind === "heatmap" ? 120 + series.length * 95 : 0);
  if (spec.kind === "heatmap") {
    const height = Math.max(220, 54 + points.length * 32);
    const left = 120;
    const cellWidth = (width - left - 10) / series.length;
    const magnitude = Math.max(1, ...points.flatMap((point) => point.values.map((value) => Math.abs(value ?? 0))));
    return <svg viewBox={`0 0 ${width} ${height}`} style={{ height, minWidth: width }} role="group" aria-label={spec.title}>
      {series.map((entry, j) => <text className="ac-plot-label" key={entry.key} x={left + (j + 0.5) * cellWidth} y={20} textAnchor="middle">{shortLabel(entry.key, 12)}</text>)}
      {points.map((point, i) => <g key={i}>
        <text className="ac-plot-label" x={left - 12} y={51 + i * 32} textAnchor="end">{shortLabel(point.label, 15)}</text>
        {series.map((entry, j) => {
          const value = point.values[entry.index];
          const description = `${point.label}, ${entry.key}: ${formatValue(value, spec.format)}`;
          return <g key={entry.key} {...markProps(point.label, description, props) as React.SVGProps<SVGGElement>}>
            <title>{description}</title>
            <rect x={left + j * cellWidth} y={31 + i * 32} width={cellWidth - 3} height={29} fill={value !== null && value < 0 ? "var(--agw-removed)" : seriesColor(entry.index)} opacity={value === null ? 0.04 : 0.12 + Math.abs(value) / magnitude * 0.45} />
            <text className="ac-plot-label" x={left + (j + 0.5) * cellWidth} y={51 + i * 32} textAnchor="middle">{value === null ? "N/A" : formatValue(value, spec.format)}</text>
          </g>;
        })}
      </g>)}
    </svg>;
  }
  if (spec.kind === "funnel") {
    const height = Math.max(200, points.length * 66 + 20);
    return <svg viewBox={`0 0 ${width} ${height}`} style={{ height }} role="group" aria-label={spec.title}>{points.map((point, i) => {
      const top = values[i] / maximum * (width - 24);
      const bottom = (values[i + 1] ?? values[i]) / maximum * (width - 24);
      const y = 28 + i * 66;
      const description = `${point.label}: ${formatValue(values[i], spec.format)}`;
      return <g key={i} {...markProps(point.label, description, props) as React.SVGProps<SVGGElement>}>
        <title>{description}</title>
        <polygon points={`${width / 2 - top / 2},${y} ${width / 2 + top / 2},${y} ${width / 2 + bottom / 2},${y + 36} ${width / 2 - bottom / 2},${y + 36}`} fill={seriesColor(0)} opacity={0.9 - i / Math.max(1, points.length) * 0.35} />
        <text className="ac-plot-label" x={12} y={y - 7}>{shortLabel(point.label, width < 480 ? 18 : 30)}</text>
        <text className="ac-plot-label" x={width - 12} y={y - 7} textAnchor="end">{formatValue(values[i], spec.format)}</text>
      </g>;
    })}</svg>;
  }
  if (total === 0) return <p className="ac-report-empty">All values are zero. There is no share to draw.</p>;
  const offsets = [0];
  for (let i = 1; i < values.length; i += 1) offsets.push(offsets[i - 1] + values[i - 1] / total);
  const circumference = 2 * Math.PI * 94;
  return <div className="ac-donut-layout"><svg viewBox="0 0 320 320" role="group" aria-label={spec.title}>
    <text x="160" y="152" textAnchor="middle" className="ac-donut-total">{formatValue(total, spec.format)}</text>
    <text x="160" y="176" textAnchor="middle" className="ac-plot-label">Total</text>
    {points.map((point, i) => {
      const share = values[i] / total;
      const offset = offsets[i];
      if (share === 0) return null;
      const description = `${point.label}: ${formatValue(values[i], spec.format)}, ${formatValue(share, { style: "percent", digits: 1 })}`;
      return <circle key={i} {...markProps(point.label, description, props) as React.SVGProps<SVGCircleElement>} cx="160" cy="160" r="94" fill="none" stroke={seriesColor(i)} strokeWidth="32" strokeDasharray={`${share * circumference} ${circumference}`} strokeDashoffset={-offset * circumference} transform="rotate(-90 160 160)"><title>{description}</title></circle>;
    })}
  </svg><ul className="ac-donut-key" role="list">{points.map((point, i) => <li key={i}>
    <span className="ac-series-swatch" style={{ background: seriesColor(i) }} />
    {props.onSelect ? <button className="ac-report-button" type="button" aria-pressed={props.selected === point.label} onClick={() => props.onSelect?.(point.label)}>{point.label}</button> : <span>{point.label}</span>}
    <span>{formatValue(values[i], spec.format)}</span>
  </li>)}</ul></div>;
}
