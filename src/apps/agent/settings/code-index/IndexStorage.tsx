/**
 * Agent Window — Settings · Code index · Saved project indexes.
 *
 * The list is unbounded: one row per project Aurora has ever indexed, and a
 * long-lived install reaches a hundred. It borrows the skill catalog's answer
 * to the same problem (`SkillsSettings`) — a search box carrying a live
 * `shown / total` count over a scroll region of fixed height — so the section
 * occupies the same space at 3 projects and at 300, and the rest of the Code
 * index tab stays reachable underneath it.
 *
 * Rows, not the catalog's cards: every project here carries the same four
 * facts (size, when it was last built, whether it is building, whether its
 * folder still exists) and one action, which is a table, and the surrounding
 * tab is already built from `SettingsRow`.
 *
 * Largest index first. The reason to open this section is to find what is
 * using the disk, so the rows worth acting on are the ones already on screen.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentConfirm } from "@/apps/agent/components/modals/AgentConfirm";
import {
  deleteIndexStorage,
  indexSize,
  listIndexStorage,
  type StoredIndex,
} from "@/apps/agent/services/code-index/code-index";
import { AgentIcon } from "../../shared/AgentIcon";
import { AgwButton, AgwTextInput, SettingsBlock, SettingsRow, SettingsSection } from "../primitives";

const projectName = (workspace: string) =>
  workspace.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? workspace;

/** Path separators differ by machine and nobody types a backslash to search. */
const searchable = (row: StoredIndex) =>
  `${projectName(row.workspace)} ${row.workspace}`.replace(/\\/g, "/").toLowerCase();

/**
 * Sizes only change when a build finishes, so the fast poll exists for the
 * duration of a build and nothing else. Every tick re-walks each project's
 * cache directory in Rust; at a hundred projects that is a hundred directory
 * walks, and holding them at five seconds for a panel that is not changing
 * would be the panel's own cost, not the index's.
 */
const POLL_BUILDING_MS = 5_000;
const POLL_IDLE_MS = 30_000;

export const IndexStorage: React.FC = () => {
  const [rows, setRows] = useState<StoredIndex[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<StoredIndex | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef(false);
  // Read by the poll loop, which is created once and must not close over a
  // stale list to decide how long to wait next.
  const building = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await listIndexStorage();
        if (!stopped && !pending.current) {
          setRows(next);
          setError(null);
          building.current = next.some((row) => row.building);
        }
      } catch (e) {
        if (!stopped) setError(`Could not read index storage: ${String(e)}`);
      }
      if (!stopped) {
        timer = setTimeout(
          () => void poll(),
          building.current ? POLL_BUILDING_MS : POLL_IDLE_MS,
        );
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const refresh = async () => {
    if (pending.current || refreshing) return;
    setRefreshing(true);
    try {
      const next = await listIndexStorage();
      setRows(next);
      setError(null);
      building.current = next.some((row) => row.building);
    } catch (e) {
      setError(`Could not read index storage: ${String(e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async () => {
    if (!selected || pending.current) return;
    const target = selected;
    pending.current = true;
    setSelected(null);
    setBusy(true);
    setNotice(null);
    try {
      await deleteIndexStorage(target.projectId);
      const next = await listIndexStorage();
      setRows(next);
      building.current = next.some((row) => row.building);
      setError(null);
      setNotice(`Deleted the saved index for ${projectName(target.workspace)}.`);
    } catch (e) {
      setNotice(`Could not delete this index: ${String(e)}`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? (rows ?? []).filter((row) => searchable(row).includes(needle)) : rows ?? []),
    [rows, needle],
  );
  const total = rows?.length ?? 0;
  const failed = !!error || notice?.startsWith("Could not");

  return (
    <SettingsSection
      title="Saved project indexes"
      icon="folder"
      description="Local storage used by each project's index, including older AI cache files. Source files and conversations are kept when you delete an index."
    >
      <div className="agw-cidx agw-cidx-storage">
        <SettingsRow
          label="Total index storage"
          hint={rows ? `${total.toLocaleString()} projects` : "Reading saved indexes…"}
        >
          <span>{rows ? indexSize(rows.reduce((sum, row) => sum + row.bytes, 0)) : "…"}</span>
        </SettingsRow>

        {/* Search + refresh, mirroring the skill catalog's toolbar. Hidden
            below a handful of projects, where a filter over four rows is a
            control asking to be used for nothing. */}
        {total > 5 && (
          <SettingsBlock searchTerms="search find project index storage filter refresh">
            <div className="agw-cidx-find">
              <AgentIcon
                name="search"
                size={13}
                style={{ color: "var(--agw-text-subtle)", flexShrink: 0 }}
              />
              <AgwTextInput
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects by name or path…"
                aria-label="Search saved project indexes"
                className="agw-cidx-find-input"
              />
              <span className="agw-cidx-find-count">
                {needle ? `${visible.length} / ${total}` : total.toLocaleString()}
              </span>
              <AgwButton icon="retry" onClick={() => void refresh()} disabled={refreshing || busy}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </AgwButton>
            </div>
          </SettingsBlock>
        )}

        {/* The fixed area. It only becomes a scroll box once there is more
            than it can hold, so a short list still ends where it ends rather
            than sitting in a tall empty frame. */}
        <div className="agw-cidx-list agw-scroll">
          {visible.map((row) => (
            <SettingsRow
              key={row.projectId}
              label={projectName(row.workspace)}
              searchTerms={row.workspace}
              hint={
                <>
                  <span className="agw-cidx-path">{row.workspace}</span>
                  <span className="agw-cidx-storage-detail">
                    {row.building
                      ? "Build in progress"
                      : row.bytes
                        ? `${indexSize(row.bytes)}${row.updatedAt ? ` · Updated ${new Date(row.updatedAt).toLocaleString()}` : ""}`
                        : "No saved index"}
                    {!row.workspaceExists && " · Project folder unavailable"}
                  </span>
                </>
              }
            >
              <AgwButton
                variant="danger"
                icon="trash"
                disabled={busy || row.building || row.bytes === 0}
                onClick={() => setSelected(row)}
              >
                Delete index
              </AgwButton>
            </SettingsRow>
          ))}
        </div>

        {rows?.length === 0 && (
          <SettingsBlock>
            <p className="agw-cidx-empty">No project indexes saved yet.</p>
          </SettingsBlock>
        )}
        {total > 0 && visible.length === 0 && (
          <SettingsBlock searchTerms={query}>
            <p className="agw-cidx-empty">No project matches “{query.trim()}”.</p>
          </SettingsBlock>
        )}
        {(error || notice) && (
          <SettingsBlock>
            <p
              className={failed ? "agw-cidx-error" : "agw-cidx-note"}
              role={failed ? "alert" : "status"}
            >
              {error ?? notice}
            </p>
          </SettingsBlock>
        )}
      </div>
      <AgentConfirm
        open={!!selected}
        destructive
        title={`Delete index for ${selected ? projectName(selected.workspace) : "this project"}?`}
        message="Deletes saved code index and old AI cache data for this project. Keeps source files, conversations, and settings. If automatic indexing is on, the next code lookup builds it again."
        confirmLabel="Delete index"
        onConfirm={() => void remove()}
        onCancel={() => setSelected(null)}
      />
    </SettingsSection>
  );
};
