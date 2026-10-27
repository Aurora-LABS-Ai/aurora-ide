/**
 * Profile ledger: one card, four lists (Models, Providers, Projects, Tool
 * calls), sortable by any number column, filterable, with a row opening in
 * place for its detail. Probe: `Documents/aurora-profile-v2-designs.html`.
 *
 * It replaced two top-six panels and a modal holding the full list. The full
 * list now opens inside the card: "Show all" turns the body into its own
 * scroller with a bounded height, so the page never grows by a hundred rows
 * and the header row stays in view while the list scrolls (owner's call).
 *
 * Columns that need room (input, output, share) drop out as the settings
 * column narrows; the grid template is rebuilt from the visible columns, so
 * the remaining cells never shift under the wrong heading.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import { AgwSegmented } from "../primitives";
import {
  cacheHitRate,
  fmtCount,
  fmtUsd,
  type LedgerModel,
  type LedgerProject,
  type LedgerProvider,
  type ProviderGroups,
  type ToolUsage,
} from "./profile-data";

type View = "models" | "providers" | "projects" | "tools";
/** `wide` drops first, then `mid`, as the column narrows. */
type Fit = "always" | "mid" | "wide";
type Size = "s" | "m" | "l";

interface Column<R> {
  key: string;
  label: string;
  width: string;
  fit?: Fit;
  /** Sort value; a column without one is not sortable. */
  value?: (row: R) => number;
  cell: (row: R) => React.ReactNode;
  strong?: boolean;
}

interface ListSpec<R> {
  /** Plural, lower case: "models". */
  noun: string;
  /** The name column's heading: "Model". */
  heading: string;
  rows: R[];
  id: (row: R) => string;
  name: (row: R) => string;
  /** Words the filter matches besides the name. */
  search?: (row: R) => string;
  chip?: (row: R) => string | null;
  mono?: boolean;
  /** The column the bar under the name follows when nothing else is sorted. */
  defaultSort: string;
  columns: Column<R>[];
  detail?: (row: R) => React.ReactNode;
  /** A quiet row after the ranked ones, shown with the full list only. */
  trailing?: { name: string; chip: string; cell: (columnKey: string) => React.ReactNode };
}

const PAGE = 10;

const Hit: React.FC<{ rate: number }> = ({ rate }) => (
  <span className="agw-profile-hit">
    {rate}%<i style={{ "--agw-hit": `${rate}%` } as React.CSSProperties} />
  </span>
);

function useSize(ref: React.RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>("l");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number) => setSize(w < 520 ? "s" : w < 760 ? "m" : "l");
    measure(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const fits = (fit: Fit | undefined, size: Size) =>
  !fit || fit === "always" || size === "l" || (size === "m" && fit === "mid");

function List<R>({ spec, query, size }: { spec: ListSpec<R>; query: string; size: Size }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: spec.defaultSort, dir: -1 });
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const columns = spec.columns.filter((c) => fits(c.fit, size));
  const sortColumn = spec.columns.find((c) => c.key === sort.key && c.value) ?? spec.columns.find((c) => c.key === spec.defaultSort)!;
  const sorted = useMemo(() => {
    const value = sortColumn.value!;
    return spec.rows.slice().sort((a, b) => (value(b) - value(a)) * -sort.dir || spec.name(a).localeCompare(spec.name(b)));
  }, [spec, sortColumn, sort.dir]);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? sorted.filter((r) => `${spec.name(r)} ${spec.search?.(r) ?? ""}`.toLowerCase().includes(needle))
    : sorted;
  // Filtering always searches the whole list; the cap is only for browsing.
  const scrolling = expanded || Boolean(needle);
  const shown = scrolling ? matches : matches.slice(0, PAGE);
  const max = Math.max(1e-9, ...sorted.map(sortColumn.value!));
  const template = ["28px", "minmax(0, 1fr)", ...columns.map((c) => c.width), spec.detail ? "14px" : ""]
    .filter(Boolean)
    .join(" ");

  const sortBy = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));

  return (
    <div className="agw-profile-table" style={{ "--agw-ledger-cols": template } as React.CSSProperties}>
      <div className="agw-profile-thead">
        <span className="agw-profile-th" aria-hidden>#</span>
        <span className="agw-profile-th" data-align="start">{spec.heading}</span>
        {columns.map((c) =>
          c.value ? (
            <button
              key={c.key}
              type="button"
              className="agw-profile-th"
              aria-sort={sortColumn.key === c.key ? (sort.dir === -1 ? "descending" : "ascending") : "none"}
              onClick={() => sortBy(c.key)}
            >
              {c.label}
              <span className="agw-profile-th-arrow" aria-hidden>
                {sortColumn.key === c.key ? (sort.dir === -1 ? "↓" : "↑") : ""}
              </span>
            </button>
          ) : (
            <span key={c.key} className="agw-profile-th">{c.label}</span>
          ),
        )}
        {spec.detail && <span />}
      </div>

      <div className="agw-profile-tbody agw-scroll" data-scrolling={scrolling ? "" : undefined}>
        {shown.length === 0 && (
          <div className="agw-profile-empty">
            {needle ? `No ${spec.noun} match “${query.trim()}”.` : `No ${spec.noun} recorded yet.`}
          </div>
        )}
        {shown.map((row, i) => {
          const id = spec.id(row);
          const isOpen = open === id;
          const chip = spec.chip?.(row);
          const content = (
            <>
              <span className="agw-profile-idx">{i + 1}</span>
              <span className="agw-profile-main">
                <span className="agw-profile-title">
                  <span className="agw-profile-name" data-mono={spec.mono ? "" : undefined} title={spec.name(row)}>
                    {spec.name(row)}
                  </span>
                  {chip && <span className="agw-profile-chip">{chip}</span>}
                </span>
                <span className="agw-profile-track">
                  <span style={{ width: `${(sortColumn.value!(row) / max) * 100}%` }} />
                </span>
              </span>
              {columns.map((c) => (
                <span key={c.key} className="agw-profile-num" data-strong={c.strong ? "" : undefined}>
                  {c.cell(row)}
                </span>
              ))}
            </>
          );
          if (!spec.detail) {
            return (
              <div key={id} className="agw-profile-row">
                {content}
              </div>
            );
          }
          return (
            <React.Fragment key={id}>
              <button
                type="button"
                className="agw-profile-row"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : id)}
              >
                {content}
                <AgentIcon name="chevron-right" size={12} className="agw-profile-chev" />
              </button>
              {isOpen && <div className="agw-profile-detail">{spec.detail(row)}</div>}
            </React.Fragment>
          );
        })}
        {spec.trailing && !needle && (scrolling || matches.length <= PAGE) && (
          <div className="agw-profile-row" data-quiet="">
            <span className="agw-profile-idx" />
            <span className="agw-profile-main">
              <span className="agw-profile-title">
                <span className="agw-profile-name">{spec.trailing.name}</span>
                <span className="agw-profile-chip">{spec.trailing.chip}</span>
              </span>
            </span>
            {columns.map((c) => (
              <span key={c.key} className="agw-profile-num">{spec.trailing!.cell(c.key)}</span>
            ))}
            {spec.detail && <span />}
          </div>
        )}
      </div>

      <div className="agw-profile-ledger-foot">
        <span>
          {needle ? (
            <><b>{fmtCount(matches.length)}</b> of {fmtCount(sorted.length)} {spec.noun}</>
          ) : (
            <><b>{fmtCount(shown.length)}</b> of <b>{fmtCount(sorted.length)}</b> {spec.noun}</>
          )}
        </span>
        {!needle && sorted.length > PAGE && (
          <button type="button" className="agw-profile-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? `Show top ${PAGE}` : `Show all ${fmtCount(sorted.length)} ${spec.noun}`}
            <AgentIcon name="chevron-down" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

const DetailFacts: React.FC<{ facts: Array<[string, string]> }> = ({ facts }) => (
  <dl className="agw-profile-detail-facts">
    {facts.map(([label, value]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export const UsageLedger: React.FC<{
  models: LedgerModel[];
  providers: ProviderGroups;
  projects: LedgerProject[];
  tools: ToolUsage[];
  totalRequests: number;
  totalTokens: number;
}> = ({ models, providers, projects, tools, totalRequests, totalTokens }) => {
  const [view, setView] = useState<View>("models");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const size = useSize(rootRef);
  const modelTokens = Math.max(1, models.reduce((s, m) => s + m.tokens, 0));
  const toolCalls = tools.reduce((s, t) => s + t.count, 0);
  const toolTotal = Math.max(1, toolCalls);
  const anyPriced = models.some((m) => m.pricedRequests > 0);

  const modelSpec: ListSpec<LedgerModel> = {
    noun: "models",
    heading: "Model",
    rows: models,
    id: (m) => m.label,
    name: (m) => m.label,
    search: (m) => `${m.keys.join(" ")} ${m.providers.join(" ")}`,
    chip: (m) =>
      m.providers.length > 1
        ? `via ${m.providers.length} providers`
        : m.modalEndpoints > 0
          ? `${m.modalEndpoints} Modal ${m.modalEndpoints === 1 ? "endpoint" : "endpoints"}`
          : null,
    defaultSort: "tokens",
    columns: [
      { key: "tokens", label: "Billed", width: "72px", strong: true, value: (m) => m.tokens, cell: (m) => formatTokens(m.tokens) },
      { key: "in", label: "Input", width: "64px", fit: "wide", value: (m) => m.inputTokens, cell: (m) => formatTokens(m.inputTokens) },
      { key: "out", label: "Output", width: "60px", fit: "wide", value: (m) => m.outputTokens, cell: (m) => formatTokens(m.outputTokens) },
      { key: "cache", label: "Cache read", width: "76px", fit: "mid", value: (m) => m.cacheReadTokens, cell: (m) => formatTokens(m.cacheReadTokens) },
      {
        key: "hit", label: "Hit", width: "64px", fit: "mid",
        value: (m) => cacheHitRate(m.cacheReadTokens, m.inputTokens),
        cell: (m) => <Hit rate={cacheHitRate(m.cacheReadTokens, m.inputTokens)} />,
      },
      { key: "req", label: "Requests", width: "68px", strong: true, value: (m) => m.requests, cell: (m) => fmtCount(m.requests) },
      ...(anyPriced
        ? [{
            key: "cost", label: "Cost", width: "64px", fit: "mid" as Fit, value: (m: LedgerModel) => m.costUsd,
            cell: (m: LedgerModel) => (m.pricedRequests > 0 ? fmtUsd(m.costUsd) : <span title="No price set for this model">—</span>),
          }]
        : []),
      { key: "share", label: "Share", width: "44px", fit: "wide", cell: (m) => `${Math.max(1, Math.round((m.tokens / modelTokens) * 100))}%` },
    ],
    detail: (m) => (
      <>
        <div className="agw-profile-detail-list">
          <div className="agw-profile-detail-head">Reached through</div>
          <div className="agw-profile-detail-chips">
            {m.providers.map((p) => <span key={p} className="agw-profile-chip">{p}</span>)}
            {m.removedProviders > 0 && (
              <span className="agw-profile-chip">
                {m.removedProviders} removed {m.removedProviders === 1 ? "provider" : "providers"}
              </span>
            )}
          </div>
          <div className="agw-profile-detail-head">Model {m.keys.length === 1 ? "key" : "keys"}</div>
          <div className="agw-profile-detail-keys">{m.keys.map((k) => <div key={k}>{k}</div>)}</div>
        </div>
        <DetailFacts
          facts={[
            ["Billed per request", formatTokens(Math.round(m.tokens / Math.max(1, m.requests)))],
            ["Cache per request", formatTokens(Math.round(m.cacheReadTokens / Math.max(1, m.requests)))],
            ...(m.pricedRequests > 0
              ? ([
                  ["Cost", fmtUsd(m.costUsd)],
                  ["Priced requests", `${fmtCount(m.pricedRequests)} of ${fmtCount(m.requests)}`],
                ] as Array<[string, string]>)
              : ([["Cost", "No price set"]] as Array<[string, string]>)),
          ]}
        />
      </>
    ),
  };

  const removed = providers.removed;
  const providerSpec: ListSpec<LedgerProvider> = {
    noun: "providers",
    heading: "Provider",
    rows: providers.active,
    id: (p) => p.id,
    name: (p) => p.label,
    search: (p) => p.models.map((m) => m.label).join(" "),
    chip: (p) => `${p.models.length} ${p.models.length === 1 ? "model" : "models"} · ${fmtCount(p.threads)} chats`,
    defaultSort: "req",
    columns: [
      { key: "req", label: "Requests", width: "68px", strong: true, value: (p) => p.requests, cell: (p) => fmtCount(p.requests) },
      { key: "tokens", label: "Billed", width: "70px", value: (p) => p.tokens, cell: (p) => formatTokens(p.tokens) },
      { key: "in", label: "Input", width: "64px", fit: "wide", value: (p) => p.inputTokens, cell: (p) => formatTokens(p.inputTokens) },
      { key: "out", label: "Output", width: "60px", fit: "wide", value: (p) => p.outputTokens, cell: (p) => formatTokens(p.outputTokens) },
      { key: "cache", label: "Cache read", width: "76px", fit: "mid", value: (p) => p.cacheReadTokens, cell: (p) => formatTokens(p.cacheReadTokens) },
      {
        key: "hit", label: "Hit", width: "64px", fit: "mid",
        value: (p) => cacheHitRate(p.cacheReadTokens, p.inputTokens),
        cell: (p) => <Hit rate={cacheHitRate(p.cacheReadTokens, p.inputTokens)} />,
      },
    ],
    detail: (p) => (
      <>
        <div className="agw-profile-detail-list">
          <div className="agw-profile-detail-row" data-head="">
            <span>Models</span><span>Requests</span><span>Billed</span><span>Cache</span>
          </div>
          {p.models.map((m, i) => (
            <div key={`${m.label}-${i}`} className="agw-profile-detail-row">
              <span title={m.label}>{m.label}</span>
              <span data-strong="">{fmtCount(m.requests)}</span>
              <span>{formatTokens(m.tokens)}</span>
              <span>{formatTokens(m.cacheReadTokens)}</span>
            </div>
          ))}
        </div>
        <DetailFacts
          facts={[
            ["Share of requests", `${((p.requests / Math.max(1, totalRequests)) * 100).toFixed(1)}%`],
            ["Requests per chat", fmtCount(p.requests / Math.max(1, p.threads))],
            ["Billed per request", formatTokens(Math.round(p.tokens / Math.max(1, p.requests)))],
            ["Cache hit", `${cacheHitRate(p.cacheReadTokens, p.inputTokens)}%`],
          ]}
        />
      </>
    ),
    trailing:
      removed.count > 0
        ? {
            name: `${removed.count} removed ${removed.count === 1 ? "provider" : "providers"}`,
            chip: "names no longer known",
            cell: (key) =>
              key === "req"
                ? fmtCount(removed.requests)
                : key === "tokens"
                  ? formatTokens(removed.tokens)
                  : key === "cache"
                    ? formatTokens(removed.cacheReadTokens)
                    : null,
          }
        : undefined,
  };

  const projectSpec: ListSpec<LedgerProject> = {
    noun: "projects",
    heading: "Project",
    rows: projects,
    id: (p) => p.id,
    name: (p) => p.label,
    search: (p) => p.root ?? "",
    defaultSort: "tokens",
    columns: [
      { key: "tokens", label: "Billed", width: "72px", strong: true, value: (p) => p.tokens, cell: (p) => formatTokens(p.tokens) },
      { key: "cache", label: "Cache read", width: "76px", fit: "mid", value: (p) => p.cacheReadTokens, cell: (p) => formatTokens(p.cacheReadTokens) },
      { key: "req", label: "Requests", width: "68px", strong: true, value: (p) => p.requests, cell: (p) => fmtCount(p.requests) },
      { key: "chats", label: "Chats", width: "56px", fit: "wide", value: (p) => p.threads, cell: (p) => fmtCount(p.threads) },
      { key: "share", label: "Share", width: "44px", fit: "wide", cell: (p) => `${Math.max(1, Math.round((p.tokens / Math.max(1, totalTokens)) * 100))}%` },
    ],
  };

  const toolSpec: ListSpec<ToolUsage> = {
    noun: "tools",
    heading: "Tool",
    rows: tools,
    id: (t) => t.name,
    name: (t) => t.name,
    mono: true,
    defaultSort: "count",
    columns: [
      { key: "count", label: "Calls", width: "80px", strong: true, value: (t) => t.count, cell: (t) => fmtCount(t.count) },
      { key: "share", label: "Share", width: "56px", fit: "wide", cell: (t) => `${((t.count / toolTotal) * 100).toFixed(1)}%` },
    ],
  };

  const options: Array<{ value: View; label: string }> = [
    { value: "models", label: `Models ${fmtCount(models.length)}` },
    { value: "providers", label: `Providers ${fmtCount(providers.active.length)}` },
    { value: "projects", label: `Projects ${fmtCount(projects.length)}` },
    { value: "tools", label: `Tool calls ${formatTokens(toolCalls)}` },
  ];
  const noun = { models: "models", providers: "providers", projects: "projects", tools: "tools" }[view];

  return (
    <section className="agw-profile-card agw-profile-ledger" ref={rootRef} aria-label="Usage by model, provider, project and tool">
      <header className="agw-profile-ledger-head">
        <AgwSegmented<View>
          ariaLabel="List"
          value={view}
          options={options}
          onChange={(next) => {
            setView(next);
            setQuery("");
          }}
        />
        <label className="agw-profile-filter">
          <AgentIcon name="search" size={12} />
          <span className="agw-sr-only">Filter {noun}</span>
          <input
            type="text"
            value={query}
            placeholder={`Filter ${noun}`}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      {/* `key` resets sort, paging and the open row when the list changes. */}
      {view === "models" && <List key="models" spec={modelSpec} query={query} size={size} />}
      {view === "providers" && <List key="providers" spec={providerSpec} query={query} size={size} />}
      {view === "projects" && <List key="projects" spec={projectSpec} query={query} size={size} />}
      {view === "tools" && <List key="tools" spec={toolSpec} query={query} size={size} />}
    </section>
  );
};
