import { useMemo, useState } from "react";
import { aggregateValue, filterRows, formatValue } from "./data";
import { Chart } from "./Chart";
import { DataTable } from "./DataTable";
import { Metric, MetricGrid } from "./Metric";
import { MultiSelect, RangeField, SearchField, SelectField } from "./Controls";
import { validateReport } from "./validate";
import type { DataRecord, FilterValue, FilterValues, OutlineItem, ReportBlock, ReportFilter, ReportSpec } from "./types";

const STATUS_LABELS = { todo: "Pending", doing: "In progress", done: "Done", blocked: "Blocked" };

function Outline({ items, kind }: { items: OutlineItem[]; kind: "list" | "steps" | "timeline" | "tree" }) {
  const Tag = kind === "steps" || kind === "timeline" ? "ol" : "ul";
  return <Tag className={`ac-report-outline ac-report-${kind}`} role="list">{items.map((item, i) => <li key={i}>
    <div>{item.when && <span className="ac-report-period">{item.when}</span>}
      {item.status && <span className={`ac-report-item-status ac-status-${item.status}`}>{STATUS_LABELS[item.status]}</span>}
      <span><strong>{item.title}</strong>{item.detail && <span className="ac-report-description">{item.detail}</span>}</span>
    </div>
    {item.children?.length ? <Outline items={item.children} kind={kind} /> : null}
  </li>)}</Tag>;
}

function Filter({ filter, rows, value, onChange }: { filter: ReportFilter; rows: DataRecord[]; value: FilterValue | undefined; onChange: (value: FilterValue) => void }) {
  const options = useMemo(() => [...new Set(rows.map((row) => JSON.stringify(row[filter.field] ?? null)))].map((key) => ({ value: key, label: formatValue(JSON.parse(key)) })).sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true })), [rows, filter.field]);
  if (filter.kind === "multi") return <MultiSelect label={filter.label} options={options} value={Array.isArray(value) ? value : []} onChange={onChange} />;
  if (filter.kind === "range" || filter.kind === "date") return <RangeField label={filter.label} kind={filter.kind === "date" ? "date" : "number"} value={value && typeof value === "object" && !Array.isArray(value) ? value : { min: "", max: "" }} onChange={onChange} />;
  if (filter.kind === "search") return <SearchField label={filter.label} value={typeof value === "string" ? value : ""} onChange={onChange} />;
  return <SelectField label={filter.label} options={options} value={typeof value === "string" ? value : ""} onChange={onChange} />;
}

function hasValue(value: FilterValue) {
  return Array.isArray(value) ? value.length > 0 : typeof value === "object" ? !!value.min || !!value.max : value !== "";
}

function ReportContent({ spec }: { spec: ReportSpec }) {
  const [values, setValues] = useState<FilterValues>({});
  const [selection, setSelection] = useState<{ field: string; label: string } | null>(null);
  const [view, setView] = useState<string | null>(null);
  const filters = spec.filters ?? [];
  const base = useMemo(() => filterRows(spec.data, spec.filters ?? [], values), [spec.data, spec.filters, values]);
  const activeSelection = selection && base.some((row) => String(row[selection.field] ?? "Not available") === selection.label) ? selection : null;
  const rows = useMemo(() => activeSelection ? base.filter((row) => String(row[activeSelection.field] ?? "Not available") === activeSelection.label) : base, [base, activeSelection]);
  const views = [...new Set(spec.sections.map((section) => section.view).filter((label): label is string => !!label))];
  const activeView = view && views.includes(view) ? view : views[0];
  const changed = Object.values(values).some(hasValue) || !!activeSelection;
  const first = spec.sections[0];
  const leading = first && !first.title && !first.description && !first.view && first.blocks[0]?.type === "metrics" ? first.blocks[0] : null;
  const reset = () => { setValues({}); setSelection(null); };
  const renderBlock = (block: ReportBlock, index: number) => {
    switch (block.type) {
      case "metrics": return <MetricGrid key={index}>{block.items.map((item, i) => <Metric key={i} {...item}
        previous={rows.length === spec.data.length ? item.previous : undefined}
        note={item.previous !== undefined && rows.length !== spec.data.length ? [item.note, "Previous-period comparison applies to all records."].filter(Boolean).join(" ") : item.note}
        value={aggregateValue(rows, item.field, item.aggregate)} />)}</MetricGrid>;
      case "chart": return <Chart key={index} {...block} data={base} selected={activeSelection?.field === block.x ? activeSelection.label : undefined} onSelect={(label) => setSelection(activeSelection?.field === block.x && activeSelection.label === label ? null : { field: block.x, label })} />;
      case "table": return <DataTable key={index} {...block} rows={rows} />;
      case "text": return <p key={index} className="ac-report-text">{block.text}</p>;
      case "note": return <aside key={index} className={`ac-report-note ac-tone-${block.tone ?? "neutral"}`}>{block.title && <strong>{block.title}</strong>}<p>{block.text}</p></aside>;
      case "facts": return <dl key={index} className="ac-report-facts">{block.items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
      case "list": case "steps": case "timeline": case "tree": return <Outline key={index} kind={block.type} items={block.items} />;
    }
  };
  return <article className="ac-report" aria-label={spec.title}>
    <header className="ac-report-head"><h2>{spec.title}</h2>{spec.subtitle && <p>{spec.subtitle}</p>}{spec.source && <p className="ac-report-source">{spec.source}</p>}</header>
    {leading && <div className="ac-report-summary">{renderBlock(leading, 0)}</div>}
    {filters.length > 0 && <div className="ac-report-filters" aria-label="Report filters">{filters.map((filter) => <Filter key={filter.field} filter={filter} rows={spec.data} value={Object.prototype.hasOwnProperty.call(values, filter.field) ? values[filter.field] : undefined} onChange={(value) => { setValues((current) => ({ ...current, [filter.field]: value })); setSelection(null); }} />)}</div>}
    <div className="ac-report-status"><span role="status">{rows.length} of {spec.data.length} records{activeSelection ? ` · ${activeSelection.label}` : ""}</span>
      {changed && <button type="button" className="ac-report-button" onClick={reset}>Reset filters</button>}
      {activeSelection && <button type="button" className="ac-report-button" onClick={() => setSelection(null)}>Clear selection</button>}
    </div>
    {views.length > 1 && <div className="ac-report-views" role="group" aria-label="Report view">{views.map((label) => <button type="button" key={label} aria-pressed={label === activeView} onClick={() => setView(label)}>{label}</button>)}</div>}
    {rows.length === 0 && <p className="ac-report-empty">{spec.data.length ? <>No records match. Adjust a filter or <button type="button" className="ac-report-button" onClick={reset}>reset all filters</button>.</> : "No source records are available."}</p>}
    {spec.sections.map((section, i) => section.view && section.view !== activeView || i === 0 && leading && section.blocks.length === 1 ? null : <section key={i} className="ac-report-section">
      {section.title && <h3>{section.title}</h3>}{section.description && <p className="ac-report-description">{section.description}</p>}
      {(i === 0 && leading ? section.blocks.slice(1) : section.blocks).map(renderBlock)}
    </section>)}
  </article>;
}

/** The same validated report runs in the transcript and the canvas sandbox. */
export function Report({ spec }: { spec: ReportSpec }) {
  const validated = useMemo(() => validateReport(spec), [spec]);
  if (!validated.spec) return <div className="ac-report-error" role="alert"><strong>This report could not be displayed.</strong><ul>{validated.problems.slice(0, 8).map((problem, i) => <li key={i}>{problem}</li>)}</ul></div>;
  return <ReportContent spec={validated.spec} />;
}
