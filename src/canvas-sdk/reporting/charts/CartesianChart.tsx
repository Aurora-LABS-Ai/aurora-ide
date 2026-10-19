import React from "react";
import { formatValue, numericAxis, valueDomain } from "../data";
import { markProps, seriesColor, shortLabel, type DrawingProps } from "./drawing";

export function CartesianChart(props: DrawingProps) {
  const { spec, points, series } = props;
  const horizontal = spec.kind === "bar" || spec.kind === "stacked-bar";
  const stacked = spec.kind === "stacked-column" || spec.kind === "stacked-bar";
  const line = spec.kind === "line" || spec.kind === "area";
  const scatter = spec.kind === "scatter";
  const activePoints = points.map((point) => ({ ...point, values: series.map((entry) => point.values[entry.index]) }));
  const width = props.width;
  const domain = valueDomain(activePoints, stacked);
  const axis = numericAxis(domain[0], domain[1], width < 480 ? 3 : 5);
  const { low, high } = axis;
  const height = horizontal ? Math.max(260, points.length * Math.max(32, series.length * 17) + 60) : 340;
  const left = horizontal ? Math.min(140, width * 0.35) : width < 480 ? 78 : 100;
  const right = width - 24;
  const top = 30;
  const bottom = height - 66;
  const span = horizontal ? right - left : bottom - top;
  const valueAt = (value: number) => horizontal ? left + (value - low) / (high - low) * span : bottom - (value - low) / (high - low) * span;
  const zero = valueAt(0);
  const band = (horizontal ? bottom - top : right - left) / Math.max(1, points.length);
  const xNumbers = points.map((point) => point.x ?? 0);
  const xLow = Math.min(...xNumbers);
  const xHigh = Math.max(...xNumbers);
  const categoryAt = (index: number) => horizontal ? top + (index + 0.5) * band : left + (index + 0.5) * band;
  const xAt = (index: number) => scatter ? left + ((points[index].x ?? 0) - xLow) / (xHigh - xLow || 1) * (right - left) : categoryAt(index);
  const categoryTickCount = Math.min(points.length, Math.max(2, Math.floor((right - left) / 100)));
  const categoryTicks = new Set(Array.from({ length: categoryTickCount }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, categoryTickCount - 1))));
  const tickCount = width < 480 ? 3 : 5;

  return <svg className="ac-cartesian" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={spec.title} style={{ height }}>
    {axis.ticks.map((value, i) => {
      const at = valueAt(value);
      return <g key={i} className="ac-plot-axis">
        {horizontal ? <><line x1={at} x2={at} y1={top} y2={bottom} /><text x={at} y={bottom + 20} textAnchor="middle">{formatValue(value, { ...spec.format, digits: Math.min(spec.format?.digits ?? 2, 2) })}</text></> :
          <><line x1={left} x2={right} y1={at} y2={at} /><text x={left - 10} y={at + 4} textAnchor="end">{formatValue(value, { ...spec.format, digits: Math.min(spec.format?.digits ?? 2, 2) })}</text></>}
      </g>;
    })}
    <g className="ac-plot-axis">
      {spec.yLabel && <text x={left} y={15}>{spec.yLabel}</text>}
      {spec.xLabel && <text x={(left + right) / 2} y={height - 5} textAnchor="middle">{spec.xLabel}</text>}
      {scatter ? Array.from({ length: tickCount }, (_, i) => <text key={i} x={left + i / (tickCount - 1) * (right - left)} y={bottom + 24} textAnchor="middle">{formatValue(xLow + (xHigh - xLow) * i / (tickCount - 1))}</text>) :
        points.map((point, i) => horizontal ? <text key={i} x={left - 12} y={categoryAt(i) + 4} textAnchor="end"><title>{point.label}</title>{shortLabel(point.label, Math.floor((left - 16) / 7))}</text> :
          categoryTicks.has(i) ? <text key={i} x={categoryAt(i)} y={bottom + 24} textAnchor="middle"><title>{point.label}</title>{shortLabel(point.label, width < 480 ? 7 : 13)}</text> : null)}
    </g>
    {line && series.map((entry) => {
      const segments: { x: number; y: number }[][] = [[]];
      points.forEach((point, i) => {
        const value = point.values[entry.index];
        if (value === null) { if (segments[segments.length - 1].length) segments.push([]); }
        else segments[segments.length - 1].push({ x: categoryAt(i), y: valueAt(value) });
      });
      return <g key={entry.key} style={{ color: seriesColor(entry.index) }}>
        {segments.filter((segment) => segment.length > 1).map((segment, index) => {
          const path = segment.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ");
          return <React.Fragment key={index}>
            {spec.kind === "area" && <path d={`${path} L${segment[segment.length - 1].x},${zero} L${segment[0].x},${zero} Z`} fill="currentColor" opacity="0.15" />}
            <path d={path} stroke="currentColor" strokeWidth="2" strokeDasharray={entry.index ? `${entry.index * 3} 3` : undefined} fill="none" />
          </React.Fragment>;
        })}
      </g>;
    })}
    {points.map((point, i) => {
      let positive = 0;
      let negative = 0;
      return <g key={i}>{series.map((entry, j) => {
        const value = point.values[entry.index];
        if (value === null) return null;
        const description = `${point.label}, ${entry.key}: ${formatValue(value, spec.format)}`;
        const events = markProps(point.label, description, props);
        const color = seriesColor(entry.index);
        if (line || scatter) return <circle key={entry.key} {...events as React.SVGProps<SVGCircleElement>} cx={xAt(i)} cy={valueAt(value)} r={4} fill={color}><title>{description}</title></circle>;
        const start = stacked ? value >= 0 ? positive : negative : 0;
        if (value >= 0) positive += value; else negative += value;
        const first = valueAt(start);
        const end = valueAt(start + value);
        const thickness = band * 0.72 / (stacked ? 1 : series.length);
        const category = categoryAt(i) - band * 0.36 + (stacked ? 0 : j * thickness);
        return <rect key={entry.key} {...events as React.SVGProps<SVGRectElement>}
          x={horizontal ? Math.min(first, end) : category} y={horizontal ? category : Math.min(first, end)}
          width={horizontal ? Math.max(value === 0 ? 1 : 0, Math.abs(end - first)) : Math.max(1, thickness - (stacked ? 0 : 2))}
          height={horizontal ? Math.max(1, thickness - (stacked ? 0 : 2)) : Math.max(value === 0 ? 1 : 0, Math.abs(end - first))} fill={color}>
          <title>{description}</title>
        </rect>;
      })}</g>;
    })}
  </svg>;
}
