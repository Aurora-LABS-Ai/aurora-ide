import { CHART_KINDS, type Aggregate, type ChartSpec, type DataColumn, type DataRecord, type MetricSpec, type OutlineItem, type ReportBlock, type ReportFilter, type ReportSection, type ReportSpec, type ReportTone, type ValueFormat } from "./types";

export const MAX_REPORT_SOURCE = 512_000;
const AGGREGATES = ["sum", "count", "average", "min", "max", "distinct"] as const;
const TONES = ["neutral", "info", "good", "warn", "bad"] as const;
type Obj = Record<string, unknown>;

class Reader {
  problems: string[] = [];
  blocks = 0;
  outlineItems = 0;
  issue(path: string, message: string) { this.problems.push(`${path}: ${message}`); }
  object(value: unknown, path: string, allowed: string[]): Obj {
    if (!value || typeof value !== "object" || Array.isArray(value)) { this.issue(path, "expected an object"); return {}; }
    const result = value as Obj;
    for (const key of Object.keys(result)) if (!allowed.includes(key)) this.issue(`${path}.${key}`, "unknown field");
    return result;
  }
  text(value: unknown, path: string, optional = false): string | undefined {
    if (optional && value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 4000) { this.issue(path, "expected nonempty text, at most 4,000 characters"); return undefined; }
    return value;
  }
  list(value: unknown, path: string, max: number, optional = false): unknown[] {
    if (optional && value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) { this.issue(path, `expected an array with at most ${max} items`); return []; }
    return value;
  }
  choice<T extends string>(value: unknown, values: readonly T[], path: string, fallback: T): T {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !values.includes(value as T)) { this.issue(path, `expected ${values.join(", ")}`); return fallback; }
    return value as T;
  }
  format(value: unknown, path: string): ValueFormat | undefined {
    if (value === undefined) return undefined;
    const item = this.object(value, path, ["style", "currency", "digits"]);
    const style = this.choice(item.style, ["number", "currency", "percent", "bytes", "duration"], `${path}.style`, "number");
    const currency = this.text(item.currency, `${path}.currency`, true);
    if (currency && !/^[A-Z]{3}$/.test(currency)) this.issue(`${path}.currency`, "use a three-letter uppercase currency code");
    if (item.digits !== undefined && (typeof item.digits !== "number" || !Number.isInteger(item.digits) || item.digits < 0 || item.digits > 6)) this.issue(`${path}.digits`, "use an integer from 0 to 6");
    return { style, currency, digits: typeof item.digits === "number" ? item.digits : undefined };
  }
  field(value: unknown, path: string, rows: DataRecord[], optional = false): string | undefined {
    const field = this.text(value, path, optional);
    if (field && rows.length && !rows.some((row) => Object.prototype.hasOwnProperty.call(row, field))) this.issue(path, `data has no field "${field}"`);
    return field;
  }
  numeric(field: string | undefined, path: string, rows: DataRecord[]) {
    if (field && rows.some((row) => row[field] !== undefined && row[field] !== null && typeof row[field] !== "number")) this.issue(path, `"${field}" must contain numbers or null; put units in format or labels`);
  }
  metric(value: unknown, path: string, rows: DataRecord[]): MetricSpec {
    const item = this.object(value, path, ["label", "field", "aggregate", "format", "previous", "note", "tone"]);
    const field = this.field(item.field, `${path}.field`, rows, true);
    const aggregate = this.choice<Aggregate>(item.aggregate, AGGREGATES, `${path}.aggregate`, field ? "sum" : "count");
    if (!field && aggregate !== "count") this.issue(`${path}.field`, "this aggregation requires a field");
    if (aggregate !== "count" && aggregate !== "distinct") this.numeric(field, path, rows);
    if (item.previous !== undefined && (typeof item.previous !== "number" || !Number.isFinite(item.previous))) this.issue(`${path}.previous`, "expected a finite number");
    return { label: this.text(item.label, `${path}.label`) ?? "", field, aggregate, format: this.format(item.format, `${path}.format`), previous: typeof item.previous === "number" ? item.previous : undefined, note: this.text(item.note, `${path}.note`, true), tone: this.choice<ReportTone>(item.tone, TONES, `${path}.tone`, "neutral") };
  }
  outline(value: unknown, path: string, depth = 0): OutlineItem[] {
    if (depth > 4) { this.issue(path, "nesting exceeds four levels"); return []; }
    return this.list(value, path, 50).map((value, index) => {
      this.outlineItems += 1;
      if (this.outlineItems > 200) { this.issue(path, "at most 200 outline items per report"); return { title: "" }; }
      const at = `${path}[${index}]`;
      const item = this.object(value, at, ["title", "detail", "when", "status", "children"]);
      return { title: this.text(item.title, `${at}.title`) ?? "", detail: this.text(item.detail, `${at}.detail`, true), when: this.text(item.when, `${at}.when`, true), status: item.status === undefined ? undefined : this.choice<NonNullable<OutlineItem["status"]>>(item.status, ["todo", "doing", "done", "blocked"], `${at}.status`, "todo"), children: item.children === undefined ? undefined : this.outline(item.children, `${at}.children`, depth + 1) };
    });
  }
  block(value: unknown, path: string, rows: DataRecord[]): ReportBlock | null {
    this.blocks += 1;
    if (this.blocks > 64) { this.issue(path, "a report supports at most 64 blocks"); return null; }
    if (!value || typeof value !== "object" || !("type" in value)) { this.issue(path, "a block requires a type"); return null; }
    const type = (value as Obj).type;
    if (type === "metrics") {
      const item = this.object(value, path, ["type", "items"]);
      return { type, items: this.list(item.items, `${path}.items`, 12).map((metric, i) => this.metric(metric, `${path}.items[${i}]`, rows)) };
    }
    if (type === "chart") {
      const item = this.object(value, path, ["type", "title", "kind", "x", "y", "format", "xLabel", "yLabel", "aggregate", "description"]);
      const x = this.field(item.x, `${path}.x`, rows) ?? "";
      const y = this.list(item.y, `${path}.y`, 6).map((field, i) => this.field(field, `${path}.y[${i}]`, rows) ?? "");
      if (!y.length) this.issue(`${path}.y`, "at least one measure is required");
      if (new Set(y).size !== y.length) this.issue(`${path}.y`, "measure names must be unique");
      const kind = this.choice(item.kind, CHART_KINDS, `${path}.kind`, "column");
      if (["donut", "funnel"].includes(kind) && y.length !== 1) this.issue(`${path}.y`, "this chart requires exactly one measure");
      for (const field of y) this.numeric(field, path, rows);
      if (kind === "scatter") this.numeric(x, `${path}.x`, rows);
      if (["donut", "funnel"].includes(kind) && rows.some((row) => y.some((field) => typeof row[field] === "number" && Number(row[field]) < 0))) this.issue(path, "donut and funnel values must be nonnegative; use a bar or line for signed values");
      return { type, title: this.text(item.title, `${path}.title`) ?? "", kind, x, y, format: this.format(item.format, `${path}.format`), xLabel: this.text(item.xLabel, `${path}.xLabel`, true), yLabel: this.text(item.yLabel, `${path}.yLabel`, true), aggregate: this.choice<NonNullable<ChartSpec["aggregate"]>>(item.aggregate, ["sum", "average", "count"], `${path}.aggregate`, "sum"), description: this.text(item.description, `${path}.description`, true) };
    }
    if (type === "table") {
      const item = this.object(value, path, ["type", "title", "columns", "pageSize", "searchable", "details"]);
      const columns: DataColumn[] = this.list(item.columns, `${path}.columns`, 20).map((value, i) => {
        const at = `${path}.columns[${i}]`;
        const column = this.object(value, at, ["key", "label", "format", "total"]);
        const key = this.field(column.key, `${at}.key`, rows) ?? "";
        if (column.total) this.numeric(key, `${at}.total`, rows);
        return { key, label: this.text(column.label, `${at}.label`) ?? "", format: this.format(column.format, `${at}.format`), total: column.total === undefined ? undefined : this.choice<NonNullable<DataColumn["total"]>>(column.total, ["sum", "average"], `${at}.total`, "sum") };
      });
      if (!columns.length) this.issue(`${path}.columns`, "at least one column is required");
      if (new Set(columns.map((column) => column.key)).size !== columns.length) this.issue(`${path}.columns`, "column keys must be unique");
      if (item.pageSize !== undefined && (typeof item.pageSize !== "number" || !Number.isInteger(item.pageSize) || item.pageSize < 5 || item.pageSize > 100)) this.issue(`${path}.pageSize`, "use an integer from 5 to 100");
      if (item.searchable !== undefined && typeof item.searchable !== "boolean") this.issue(`${path}.searchable`, "expected true or false");
      return { type, title: this.text(item.title, `${path}.title`) ?? "", columns, pageSize: typeof item.pageSize === "number" ? item.pageSize : undefined, searchable: item.searchable !== false, details: item.details === undefined ? undefined : this.list(item.details, `${path}.details`, 20).map((field, i) => this.field(field, `${path}.details[${i}]`, rows) ?? "") };
    }
    if (type === "text" || type === "note") {
      const item = this.object(value, path, type === "text" ? ["type", "text"] : ["type", "title", "text", "tone"]);
      const text = this.text(item.text, `${path}.text`) ?? "";
      return type === "text" ? { type, text } : { type, text, title: this.text(item.title, `${path}.title`, true), tone: this.choice<ReportTone>(item.tone, TONES, `${path}.tone`, "neutral") };
    }
    if (type === "facts") {
      const item = this.object(value, path, ["type", "items"]);
      return { type, items: this.list(item.items, `${path}.items`, 30).map((value, i) => {
        const at = `${path}.items[${i}]`;
        const pair = this.object(value, at, ["label", "value"]);
        return { label: this.text(pair.label, `${at}.label`) ?? "", value: this.text(pair.value, `${at}.value`) ?? "" };
      }) };
    }
    if (type === "list" || type === "steps" || type === "timeline" || type === "tree") {
      const item = this.object(value, path, ["type", "items"]);
      const items = this.outline(item.items, `${path}.items`);
      if (type === "timeline" && items.some((entry) => !entry.when)) this.issue(`${path}.items`, "timeline events require when");
      return { type, items };
    }
    this.issue(`${path}.type`, "unknown block type");
    return null;
  }
}

export function validateReport(value: unknown): { spec: ReportSpec | null; problems: string[] } {
  const read = new Reader();
  const input = read.object(value, "report", ["title", "subtitle", "source", "data", "filters", "sections"]);
  const rows: DataRecord[] = read.list(input.data, "data", 2000).map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) { read.issue(`data[${index}]`, "expected a flat record"); return {}; }
    const record = value as DataRecord;
    if (Object.keys(record).length > 64) read.issue(`data[${index}]`, "at most 64 fields per record");
    for (const [key, cell] of Object.entries(record)) if (cell !== null && ((typeof cell !== "string" && typeof cell !== "number" && typeof cell !== "boolean") || (typeof cell === "number" && !Number.isFinite(cell)) || (typeof cell === "string" && cell.length > 4000))) read.issue(`data[${index}].${key}`, "expected finite number, text, boolean or null");
    return Object.assign(Object.create(null) as DataRecord, record);
  });
  const filters: ReportFilter[] = read.list(input.filters, "filters", 12, true).map((value, i) => {
    const path = `filters[${i}]`;
    const item = read.object(value, path, ["field", "label", "kind"]);
    const field = read.field(item.field, `${path}.field`, rows) ?? "";
    const kind = read.choice(item.kind, ["select", "multi", "search", "range", "date"], `${path}.kind`, "select");
    if (kind === "range") read.numeric(field, path, rows);
    if (kind === "date" && rows.some((row) => row[field] !== null && row[field] !== undefined && (typeof row[field] !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(String(row[field]))))) read.issue(path, "date filters require ISO date strings");
    return { field, label: read.text(item.label, `${path}.label`) ?? "", kind };
  });
  if (new Set(filters.map((filter) => filter.field)).size !== filters.length) read.issue("filters", "use one filter per field");
  const sections: ReportSection[] = read.list(input.sections, "sections", 24).map((value, i) => {
    const path = `sections[${i}]`;
    const item = read.object(value, path, ["title", "description", "view", "blocks"]);
    return { title: read.text(item.title, `${path}.title`, true), description: read.text(item.description, `${path}.description`, true), view: read.text(item.view, `${path}.view`, true), blocks: read.list(item.blocks, `${path}.blocks`, 24).map((block, j) => read.block(block, `${path}.blocks[${j}]`, rows)).filter((block): block is ReportBlock => block !== null) };
  });
  if (!sections.some((section) => section.blocks.length)) read.issue("sections", "at least one block is required");
  const spec: ReportSpec = { title: read.text(input.title, "title") ?? "", subtitle: read.text(input.subtitle, "subtitle", true), source: read.text(input.source, "source", true), data: rows, filters, sections };
  return { spec: read.problems.length ? null : spec, problems: read.problems };
}

export function parseReportSource(source: string) {
  if (source.length > MAX_REPORT_SOURCE) return { spec: null, problems: [`Report source exceeds ${MAX_REPORT_SOURCE.toLocaleString("en-US")} characters.`] };
  try { return validateReport(JSON.parse(source)); }
  catch (error) { return { spec: null, problems: [`Report JSON could not be read: ${error instanceof Error ? error.message : String(error)}`] }; }
}
