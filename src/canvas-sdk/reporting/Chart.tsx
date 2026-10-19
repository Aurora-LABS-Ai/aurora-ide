import { useEffect, useMemo, useRef, useState } from "react";
import { chartPoints } from "./data";
import { DataTable } from "./DataTable";
import { CartesianChart } from "./charts/CartesianChart";
import { PartChart } from "./charts/PartCharts";
import { seriesColor } from "./charts/drawing";
import type { ChartSpec, DataRecord } from "./types";

export interface ChartProps extends Omit<ChartSpec, "type"> {
  data: DataRecord[];
  selected?: string;
  onSelect?: (label: string) => void;
}

export function Chart({ data, selected, onSelect, title, x, y, kind, aggregate, format, xLabel, yLabel, description }: ChartProps) {
  const points = useMemo(() => chartPoints(data, { type: "chart", title: "", x, y, kind, aggregate }), [data, x, y, kind, aggregate]);
  const spec: ChartSpec = { type: "chart", title, x, y, kind, aggregate, format, xLabel, yLabel, description };
  const tableColumns = useMemo(() => [{ key: x, label: xLabel ?? x }, ...y.map((key) => ({ key, label: key, format }))], [x, xLabel, y, format]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [inspection, setInspection] = useState<string | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);
  const available = y.map((key, index) => ({ key, index }));
  const active = available.filter((entry) => !hidden.includes(entry.key));
  const series = active.length ? active : available.slice(0, 1);
  const part = kind === "donut" || kind === "funnel" || kind === "heatmap";
  const invalid = (kind === "donut" || kind === "funnel") && points.some((point) => point.values.some((value) => value !== null && value < 0));
  return <figure className="ac-report-chart" aria-label={spec.title}>
    <figcaption>{spec.title}</figcaption>
    {spec.description && <p className="ac-report-description">{spec.description}</p>}
    {y.length > 1 && <div className="ac-chart-legend" aria-label="Visible series">{available.map((entry) => {
      const shown = series.some((visible) => visible.key === entry.key);
      return <button type="button" className="ac-report-button" key={entry.key} aria-pressed={shown} disabled={shown && series.length === 1} onClick={() => setHidden(shown ? [...hidden, entry.key] : hidden.filter((key) => key !== entry.key))}>
        <span className="ac-series-swatch" style={{ background: seriesColor(entry.index) }} />{entry.key}
      </button>;
    })}</div>}
    <div className="ac-chart-viewport" ref={plotRef}>
      {points.length === 0 ? <p className="ac-report-empty">No data matches the current filters.</p> : !points.some((point) => point.values.some((value) => value !== null)) ? <p className="ac-report-empty">No numeric measurements are available.</p> : invalid ? <p className="ac-report-error">This chart requires nonnegative values. Use the data table or a bar chart for signed values.</p> :
        part ? <PartChart width={width} spec={spec} points={points} series={series} selected={selected} onSelect={onSelect} onInspect={setInspection} /> : <CartesianChart width={width} spec={spec} points={points} series={series} selected={selected} onSelect={onSelect} onInspect={setInspection} />}
    </div>
    <div className="ac-chart-inspection">{inspection ?? (onSelect ? "Select a mark to inspect that category. Select it again to clear." : "Focus or point at a mark to read its value.")}</div>
    <details className="ac-chart-data"><summary>View chart data</summary>
      <DataTable title={`${spec.title} data`} rows={data} columns={tableColumns} />
    </details>
  </figure>;
}
