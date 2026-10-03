/**
 * Profile ranked lists: the Models and Providers panels and the dialog that
 * holds the full list.
 *
 * A panel shows the top six. The page used to print every provider ever used
 * (76 rows, a quarter of them deleted) and became five screens long; the full
 * list is still one click away, searchable, in a dialog that shares the
 * window's modal chrome (`.agw-confirm-overlay`).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import type { RankRow } from "./profile-data";

const PANEL_ROWS = 6;

const Row: React.FC<{ row: RankRow; max: number; format: (n: number) => string; quiet?: boolean }> = ({
  row,
  max,
  format,
  quiet,
}) => (
  <div className="agw-profile-rank" data-quiet={quiet ? "" : undefined}>
    <span className="agw-profile-rank-name">
      <span className="agw-profile-rank-label" title={row.label}>
        {row.label}
        {row.detail && <small>{row.detail}</small>}
      </span>
      <span className="agw-profile-rank-track">
        <span style={{ width: `${Math.max(0, (row.value / Math.max(1, max)) * 100)}%` }} />
      </span>
    </span>
    <span className="agw-profile-rank-value">{format(row.value)}</span>
    <span className="agw-profile-rank-aside">{row.aside}</span>
  </div>
);

export const RankPanel: React.FC<{
  title: string;
  subtitle: string;
  rows: RankRow[];
  format: (n: number) => string;
  /** "providers" → "All 49 providers". */
  noun: string;
  empty: string;
  /** Rows shown after the ranked list in the full dialog only. */
  trailing?: { heading: string; row: RankRow };
}> = ({ title, subtitle, rows, format, noun, empty, trailing }) => {
  const [open, setOpen] = useState(false);
  const max = rows[0]?.value ?? 1;
  const hidden = rows.length > PANEL_ROWS || Boolean(trailing);

  return (
    <section className="agw-profile-panel">
      <header className="agw-profile-panel-head">
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </header>
      {rows.length === 0 ? (
        <div className="agw-profile-panel-empty">{empty}</div>
      ) : (
        rows.slice(0, PANEL_ROWS).map((row) => <Row key={row.id} row={row} max={max} format={format} />)
      )}
      {hidden && (
        <button type="button" className="agw-profile-panel-more" onClick={() => setOpen(true)}>
          All {rows.length} {noun}
          <AgentIcon name="chevron-right" size={12} />
        </button>
      )}
      {open && (
        <RankDialog
          title={title}
          noun={noun}
          rows={rows}
          format={format}
          trailing={trailing}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
};

const RankDialog: React.FC<{
  title: string;
  noun: string;
  rows: RankRow[];
  format: (n: number) => string;
  trailing?: { heading: string; row: RankRow };
  onClose: () => void;
}> = ({ title, noun, rows, format, trailing, onClose }) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const portalTarget =
    typeof document !== "undefined"
      ? ((document.querySelector(".agw-root") as HTMLElement | null) ?? document.body)
      : null;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows),
    [rows, needle],
  );
  const max = rows[0]?.value ?? 1;

  if (!portalTarget) return null;
  return createPortal(
    <div className="agw-confirm-overlay" onClick={onClose}>
      <div
        className="agw-confirm-dialog agw-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`All ${noun}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agw-profile-dialog-head">
          <h2>{title}</h2>
          <span>{rows.length}</span>
          <button
            type="button"
            className="agw-prov-icon-btn"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
          >
            <AgentIcon name="close" size={14} />
          </button>
        </header>
        <input
          ref={inputRef}
          className="agw-set-input agw-profile-dialog-search"
          placeholder={`Filter ${noun}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
        <div className="agw-profile-dialog-body agw-scroll">
          {shown.map((row) => (
            <Row key={row.id} row={row} max={max} format={format} />
          ))}
          {shown.length === 0 && (
            <div className="agw-profile-panel-empty">No {noun} match “{query.trim()}”.</div>
          )}
          {trailing && !needle && (
            <>
              <div className="agw-profile-dialog-group">{trailing.heading}</div>
              <Row row={trailing.row} max={max} format={format} quiet />
            </>
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
};
