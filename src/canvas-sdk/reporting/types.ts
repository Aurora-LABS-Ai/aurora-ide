export type CellValue = string | number | boolean | null;
export type DataRecord = Record<string, CellValue>;
export type Aggregate = "sum" | "count" | "average" | "min" | "max" | "distinct";
export type ReportTone = "neutral" | "info" | "good" | "warn" | "bad";
export interface ValueFormat {
  style?: "number" | "currency" | "percent" | "bytes" | "duration";
  currency?: string;
  digits?: number;
}
export interface MetricSpec {
  label: string;
  field?: string;
  aggregate?: Aggregate;
  format?: ValueFormat;
  previous?: number;
  note?: string;
  tone?: ReportTone;
}
export const CHART_KINDS = ["column", "bar", "line", "area", "stacked-column", "stacked-bar", "donut", "scatter", "heatmap", "funnel"] as const;
export type ChartKind = typeof CHART_KINDS[number];
export interface ChartSpec {
  type: "chart";
  title: string;
  kind: ChartKind;
  x: string;
  y: string[];
  format?: ValueFormat;
  xLabel?: string;
  yLabel?: string;
  aggregate?: "sum" | "average" | "count";
  description?: string;
}
export interface DataColumn {
  key: string;
  label: string;
  format?: ValueFormat;
  total?: "sum" | "average";
}
export interface TableSpec {
  type: "table";
  title: string;
  columns: DataColumn[];
  pageSize?: number;
  searchable?: boolean;
  details?: string[];
}
export interface ReportFilter {
  field: string;
  label: string;
  kind: "select" | "multi" | "search" | "range" | "date";
}
export type FilterValue = string | string[] | { min: string; max: string };
export type FilterValues = Record<string, FilterValue>;
export interface OutlineItem {
  title: string;
  detail?: string;
  when?: string;
  status?: "todo" | "doing" | "done" | "blocked";
  children?: OutlineItem[];
}
export type ReportBlock =
  | { type: "metrics"; items: MetricSpec[] }
  | ChartSpec
  | TableSpec
  | { type: "text"; text: string }
  | { type: "note"; title?: string; text: string; tone?: ReportTone }
  | { type: "facts"; items: { label: string; value: string }[] }
  | { type: "list" | "steps" | "timeline" | "tree"; items: OutlineItem[] };
export interface ReportSection {
  title?: string;
  description?: string;
  /** Sections with the same view label switch together; unlabelled sections stay visible. */
  view?: string;
  blocks: ReportBlock[];
}
export interface ReportSpec {
  title: string;
  subtitle?: string;
  source?: string;
  data: DataRecord[];
  filters?: ReportFilter[];
  sections: ReportSection[];
}
