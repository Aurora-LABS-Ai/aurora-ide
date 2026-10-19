import { useEffect, useMemo, useRef, useState } from "react";
import { aggregateValue, formatValue } from "./data";
import { SearchField, Toggle } from "./Controls";
import type { CellValue, DataColumn, DataRecord } from "./types";

export interface DataTableProps {
  title: string;
  columns: DataColumn[];
  rows: DataRecord[];
  pageSize?: number;
  searchable?: boolean;
  details?: string[];
  onSelect?: (row: DataRecord | null) => void;
}

function compare(a: CellValue | undefined, b: CellValue | undefined) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "en", { numeric: true });
}

export function DataTable({ title, columns, rows, pageSize = 10, searchable = true, details, onSelect }: DataTableProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [showTotals, setShowTotals] = useState(true);
  const [selected, setSelected] = useState<DataRecord | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOverflow(element.scrollWidth > element.clientWidth + 1));
    observer.observe(element);
    const table = element.querySelector("table");
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, []);
  const numeric = useMemo(() => new Set(columns.filter((column) => {
    const present = rows.map((row) => row[column.key]).filter((value) => value !== null && value !== undefined);
    return present.length > 0 && present.every((value) => typeof value === "number");
  }).map((column) => column.key)), [columns, rows]);
  const matching = useMemo(() => rows.filter((row) => !query || columns.some((column) => String(row[column.key] ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase()))), [rows, columns, query]);
  const sorted = useMemo(() => sort ? [...matching].sort((a, b) => {
    // Missing values stay last in either direction.
    if (a[sort.key] === null || a[sort.key] === undefined) return b[sort.key] === null || b[sort.key] === undefined ? 0 : 1;
    if (b[sort.key] === null || b[sort.key] === undefined) return -1;
    return compare(a[sort.key], b[sort.key]) * (sort.descending ? -1 : 1);
  }) : matching, [matching, sort]);
  const size = Math.min(100, Math.max(5, Math.round(pageSize)));
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * size, (current + 1) * size);
  const active = selected && matching.includes(selected) ? selected : null;
  const hasTotals = columns.some((column) => column.total);
  const select = (row: DataRecord | null) => { setSelected(row); onSelect?.(row); };
  const interactive = !!details?.length || !!onSelect;
  return <section className="ac-data-table" aria-label={title}>
    <div className="ac-data-toolbar">
      {searchable && <SearchField label={`Search ${title}`} value={query} onChange={(value) => { setQuery(value); setPage(0); }} />}
      {hasTotals && <Toggle label="Show totals" checked={showTotals} onChange={setShowTotals} />}
    </div>
    {overflow && <p className="ac-report-hint">Scroll horizontally to view all columns.</p>}
    <div className="ac-data-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label={`${title} table`}>
      <table>
        <caption>{title}</caption>
        <thead><tr>{columns.map((column) => <th key={column.key} scope="col" data-numeric={numeric.has(column.key) || undefined} aria-sort={sort?.key === column.key ? sort.descending ? "descending" : "ascending" : "none"}>
          <button type="button" onClick={() => { setSort({ key: column.key, descending: sort?.key === column.key ? !sort.descending : false }); setPage(0); }}>
            {column.label}<span aria-hidden="true">{sort?.key === column.key ? sort.descending ? " ↓" : " ↑" : " ↕"}</span>
          </button>
        </th>)}{interactive && <th scope="col">Details</th>}</tr></thead>
        <tbody>{visible.map((row, index) => <tr key={index} data-selected={active === row || undefined}>
          {columns.map((column) => <td key={column.key} data-numeric={typeof row[column.key] === "number" || undefined}>{formatValue(row[column.key], column.format)}</td>)}
          {interactive && <td><button type="button" className="ac-report-button" aria-pressed={active === row} onClick={() => select(active === row ? null : row)}>Inspect<span className="ac-report-sr"> row {current * size + index + 1}</span></button></td>}
        </tr>)}</tbody>
        {showTotals && hasTotals && matching.length > 0 && <tfoot><tr>{columns.map((column, i) => <td key={column.key} data-numeric={!!column.total || undefined}>
          {column.total ? formatValue(aggregateValue(matching, column.key, column.total), column.format) : i === 0 ? "Total" : ""}
        </td>)}{interactive && <td />}</tr></tfoot>}
      </table>
      {matching.length === 0 && <p className="ac-report-empty" role="status">No rows match{query ? ` "${query}"` : " the current filters"}.{query && <button type="button" className="ac-report-button" onClick={() => setQuery("")}>Clear search</button>}</p>}
    </div>
    <div className="ac-data-pagination">
      <span role="status">{sorted.length ? `${current * size + 1}–${Math.min((current + 1) * size, sorted.length)} of ${sorted.length} rows` : "0 rows"}</span>
      <div><button type="button" className="ac-report-button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
        <span>Page {current + 1} of {pages}</span><button type="button" className="ac-report-button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button></div>
    </div>
    {active && !!details?.length && <aside className="ac-data-details" aria-label="Selected row details">
      <div><strong>Selected row</strong><button type="button" className="ac-report-button" onClick={() => select(null)}>Close details</button></div>
      <dl>{details.map((field) => <div key={field}><dt>{columns.find((column) => column.key === field)?.label ?? field}</dt><dd>{formatValue(active[field], columns.find((column) => column.key === field)?.format)}</dd></div>)}</dl>
    </aside>}
  </section>;
}
