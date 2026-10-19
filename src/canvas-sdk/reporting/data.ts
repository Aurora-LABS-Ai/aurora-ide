import type { Aggregate, CellValue, ChartSpec, DataRecord, FilterValues, ReportFilter, ValueFormat } from "./types";

export function formatValue(value: CellValue | undefined, format: ValueFormat = {}): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "Not available";
  const digits = Math.min(6, Math.max(0, format.digits ?? (format.style === "currency" ? 2 : 2)));
  if (format.style === "bytes") {
    const index = value === 0 ? 0 : Math.min(4, Math.max(0, Math.floor(Math.log(Math.abs(value)) / Math.log(1024))));
    return `${formatValue(value / 1024 ** index, { digits })} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
  }
  if (format.style === "duration") return `${formatValue(value, { digits })} ms`;
  return new Intl.NumberFormat("en-US", {
    style: format.style === "currency" || format.style === "percent" ? format.style : "decimal",
    ...(format.style === "currency" ? { currency: format.currency ?? "USD" } : {}),
    maximumFractionDigits: digits,
    minimumFractionDigits: format.style === "currency" ? digits : 0,
  }).format(value);
}

export function aggregateValue(rows: DataRecord[], field: string | undefined, aggregate: Aggregate = "sum"): number | null {
  if (aggregate === "count") return rows.length;
  if (!field) return null;
  if (aggregate === "distinct") return new Set(rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined)).size;
  const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return aggregate === "sum" && rows.length === 0 ? 0 : null;
  switch (aggregate) {
    case "sum": return values.reduce((sum, value) => sum + value, 0);
    case "average": return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
  }
}

export function filterRows(rows: DataRecord[], filters: ReportFilter[], values: FilterValues): DataRecord[] {
  return rows.filter((row) => filters.every((filter) => {
    const value = Object.prototype.hasOwnProperty.call(values, filter.field) ? values[filter.field] : undefined;
    if (value === undefined || value === "") return true;
    const cell = row[filter.field];
    if (Array.isArray(value)) return value.length === 0 || value.includes(JSON.stringify(cell ?? null));
    if (typeof value === "object") {
      if (!value.min && !value.max) return true;
      if (cell === null || cell === undefined) return false;
      if (filter.kind === "range") {
        return typeof cell === "number" && (!value.min || cell >= Number(value.min)) && (!value.max || cell <= Number(value.max));
      }
      // ISO date strings compare in calendar order without timezone conversion.
      const date = String(cell).slice(0, 10);
      return (!value.min || date >= value.min) && (!value.max || date <= value.max);
    }
    if (filter.kind !== "search") return JSON.stringify(cell ?? null) === value;
    return cell !== null && cell !== undefined && String(cell).toLocaleLowerCase().includes(value.toLocaleLowerCase());
  }));
}

export interface ChartPoint { label: string; values: (number | null)[]; x?: number }

export function chartPoints(rows: DataRecord[], spec: ChartSpec): ChartPoint[] {
  if (spec.kind === "scatter") {
    return rows.filter((row) => typeof row[spec.x] === "number").map((row) => ({
      label: String(row[spec.x]), x: Number(row[spec.x]),
      values: spec.y.map((key) => typeof row[key] === "number" ? row[key] as number : null),
    }));
  }
  const groups = new Map<string, DataRecord[]>();
  for (const row of rows) {
    const label = row[spec.x] === null || row[spec.x] === undefined ? "Not available" : String(row[spec.x]);
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  return [...groups].map(([label, group]) => ({
    label, values: spec.y.map((key) => aggregateValue(group, key, spec.aggregate ?? "sum")),
  }));
}

/** Numeric axes include zero for magnitude charts and retain negative values. */
export function valueDomain(points: ChartPoint[], stacked = false): [number, number] {
  let low = 0;
  let high = 0;
  for (const point of points) {
    if (stacked) {
      low = Math.min(low, point.values.reduce<number>((sum, value) => sum + Math.min(0, value ?? 0), 0));
      high = Math.max(high, point.values.reduce<number>((sum, value) => sum + Math.max(0, value ?? 0), 0));
    } else for (const value of point.values) {
      if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); }
    }
  }
  return low === high ? [0, 1] : [low, high];
}

/** Expand outward to readable ticks, retaining the data's full domain. */
export function numericAxis(low: number, high: number, target = 5) {
  const raw = (high - low || 1) / Math.max(1, target - 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const count = Math.round((end - start) / step) + 1;
  return { low: start, high: end === start ? end + step : end, ticks: Array.from({ length: Math.min(12, count) }, (_, i) => Number((start + i * step).toPrecision(12))) };
}
