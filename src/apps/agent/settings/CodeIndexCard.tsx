/**
 * Agent Window — Settings · Agent · Code index.
 *
 * Status and a Rebuild button. Deliberately NOT a toggle: the index builds in
 * well under a second, unlike the embedding indexer it replaced, so an on/off
 * switch would be a control whose only possible effect is to make the agent
 * worse at reading the project. Owner's decision, recorded here so it is not
 * "helpfully" reintroduced.
 *
 * Reading status never builds. Opening this page on a large workspace must not
 * cost anything — the numbers below describe what is already cached, and the
 * only thing that indexes is the button someone pressed.
 */

import React, { useCallback, useEffect, useState } from "react";

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { AgwButton, SettingsBlock, SettingsRow } from "./primitives";

/** Mirrors Rust `code_index::IndexStatus` (serde camelCase). */
interface IndexStatus {
  workspace: string;
  built: boolean;
  files: number;
  symbols: number;
  refs: number;
  buildMs: number;
  skippedGenerated: number;
  skippedDirs: string[];
  cachePath: string;
  cacheBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

/** One number plus what it means. */
const Stat: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <div className="agw-cidx-stat">
    <div className="agw-cidx-stat-value">{value}</div>
    <div className="agw-cidx-stat-label">{label}</div>
  </div>
);

export const CodeIndexCard: React.FC = () => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectRoot) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await invoke<IndexStatus>("code_index_status", {
        workspacePath: projectRoot,
      });
      setStatus(next);
      setError(null);
    } catch (e) {
      // A failed READ must not read as a failed index — say which one broke.
      setError(`Could not read the index status: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = useCallback(async () => {
    if (!projectRoot || rebuilding) return;
    setRebuilding(true);
    setError(null);
    try {
      const next = await invoke<IndexStatus>("code_index_rebuild", {
        workspacePath: projectRoot,
      });
      setStatus(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setRebuilding(false);
    }
  }, [projectRoot, rebuilding]);

  // No workspace: say so plainly and offer no control, rather than shipping a
  // Rebuild button that cannot do anything.
  if (!projectRoot) {
    return (
      <SettingsBlock last>
        <p className="agw-cidx-empty">
          Open a project to index it. The agent uses this index to find where a
          symbol is defined and what calls it.
        </p>
      </SettingsBlock>
    );
  }

  const built = status?.built === true;

  return (
    <>
      <SettingsBlock>
        {loading && !status ? (
          <p className="agw-cidx-empty">Reading index status…</p>
        ) : built && status ? (
          <div className="agw-cidx-stats">
            <Stat value={formatCount(status.files)} label="files" />
            <Stat value={formatCount(status.symbols)} label="symbols" />
            <Stat value={formatCount(status.refs)} label="references" />
            <Stat value={`${formatCount(status.buildMs)} ms`} label="build time" />
          </div>
        ) : (
          <p className="agw-cidx-empty">
            Not built yet. It builds itself the first time the agent looks up a
            symbol — this button is only for forcing it early.
          </p>
        )}
      </SettingsBlock>

      {built && status && status.skippedGenerated > 0 && (
        <SettingsBlock>
          {/* Reported rather than silent: a skipped file the user wanted
              indexed is invisible otherwise, and a truncation that does not
              name itself reads as "we covered everything". */}
          <p className="agw-cidx-note">
            {formatCount(status.skippedGenerated)} generated or minified{" "}
            {status.skippedGenerated === 1 ? "file was" : "files were"} skipped.
            {status.skippedDirs.length > 0 && (
              <> Excluded folders here: {status.skippedDirs.join(", ")}.</>
            )}
          </p>
        </SettingsBlock>
      )}

      {error && (
        <SettingsBlock>
          <p className="agw-cidx-error" role="alert">
            {error}
          </p>
        </SettingsBlock>
      )}

      <SettingsRow
        label="Rebuild index"
        hint={
          built && status
            ? `Cache ${formatBytes(status.cacheBytes)}. The index re-checks itself before every answer — rebuild after renaming or deleting several files at once.`
            : "Parses every source file in this project. Usually under a second."
        }
        last
      >
        <AgwButton onClick={rebuild} disabled={rebuilding} icon="retry">
          {rebuilding ? "Rebuilding…" : "Rebuild"}
        </AgwButton>
      </SettingsRow>
    </>
  );
};
