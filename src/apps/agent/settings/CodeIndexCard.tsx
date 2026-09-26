/** Local index controls. Jobs live in the app, independently of this page. */
import React, { useState } from "react";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useCodeIndex } from "@/apps/agent/hooks/code-index/useCodeIndex";
import { buildProgress, indexSize } from "@/apps/agent/services/code-index/code-index";
import { AgwButton, AgwSwitch, SettingsBlock, SettingsRow, SettingsSection } from "./primitives";
import { IndexSearchSettings } from "./code-index/IndexSearchSettings";
import { IndexStorage } from "./code-index/IndexStorage";

const Stat: React.FC<{ value: string | number; label: string }> = ({ value, label }) => <div className="agw-cidx-stat">
  <div className="agw-cidx-stat-value">{value.toLocaleString()}</div><div className="agw-cidx-stat-label">{label}</div>
</div>;

const ProjectCodeIndex: React.FC<{ workspace: string }> = ({ workspace }) => {
  const { snapshot, error, busy, building, save, build, cancel } = useCodeIndex(workspace);
  const [dirty, setDirty] = useState(false);
  const index = snapshot?.index; const job = snapshot?.job;
  const percent = job?.totalFiles ? Math.min(100, Math.floor(job.completedFiles / job.totalFiles * 100)) : null;
  return <>
    <SettingsSection title="Code index" icon="workspace-tree" description="Find definitions, callers, and matching code. Built locally for this project; no model or API calls.">
      <div className="agw-cidx">
        <SettingsBlock>
          {!snapshot ? <p className="agw-cidx-empty">Reading index status…</p> : index?.built ? <div className="agw-cidx-stats">
            <Stat value={index.files} label="files" /><Stat value={index.symbols} label="symbols" />
            <Stat value={index.refs} label="references" /><Stat value={indexSize(index.cacheBytes)} label="index size" />
          </div> : <p className="agw-cidx-empty">Build an index to find definitions, callers, and matching code.</p>}
        </SettingsBlock>
        <SettingsRow label="Build automatically when needed" hint="The agent builds or updates this project's index before a lookup. Turn off to build only from these controls.">
          <AgwSwitch ariaLabel="Build automatically when needed" checked={snapshot?.settings.autoBuild ?? true} disabled={!snapshot || busy}
            onChange={(autoBuild) => snapshot && void save({ ...snapshot.settings, autoBuild })} />
        </SettingsRow>
        {index?.built && <SettingsBlock><p className="agw-cidx-note">
          Last build: {(index.buildMs / 1000).toFixed(1)} seconds. {index.reusedFiles.toLocaleString()} unchanged files reused.
          {!!index.skippedGenerated && <> {index.skippedGenerated.toLocaleString()} generated files skipped.</>}
          {!!index.skippedDirs.length && <> Excluded folders: {index.skippedDirs.join(", ")}.</>}
        </p></SettingsBlock>}
        {job && <SettingsBlock>
          {building && <div className="agw-cidx-progress">
            <div className="agw-cidx-progress-label"><span>{job.phase === "queued" ? "Build queued" : "Indexing code"}</span>{percent !== null && <span>{percent}% of files</span>}</div>
            <div className="agw-cidx-progress-track" role="progressbar" aria-label="Indexing progress" aria-valuemin={0}
              aria-valuemax={job.totalFiles || undefined} aria-valuenow={job.totalFiles ? job.completedFiles : undefined} aria-valuetext={buildProgress(job)}>
              {percent !== null && <span style={{ width: `${percent}%` }} />}
            </div>
          </div>}
          <p className={job.phase === "failed" ? "agw-cidx-error" : "agw-cidx-note"} role="status">{buildProgress(job)}{building && " You can switch projects. Keep Aurora open."}</p>
        </SettingsBlock>}
        {error && <SettingsBlock><p className="agw-cidx-error" role="alert">{error}</p></SettingsBlock>}
        <SettingsRow label={building ? "Build in progress" : index?.built ? "Rebuild index" : "Build index"}
          hint="Reuses unchanged files and updates added, edited, or deleted files. Each project keeps its own saved index." last>
          {building ? <AgwButton disabled={busy} onClick={() => void cancel()}>Stop build</AgwButton>
            : <AgwButton disabled={!snapshot || busy || dirty} icon="retry" onClick={() => void build()}>{busy ? "Saving…" : index?.built ? "Rebuild" : "Build"}</AgwButton>}
        </SettingsRow>
      </div>
    </SettingsSection>
    {snapshot && <IndexSearchSettings key={`${snapshot.settings.searchResults}:${snapshot.settings.searchBytes}`}
      settings={snapshot.settings} disabled={busy} onDirty={setDirty} onSave={save} />}
  </>;
};

export const CodeIndexCard: React.FC = () => {
  const workspace = useAgentChatStore((state) => state.projectRoot);
  return <>{workspace ? <ProjectCodeIndex key={workspace} workspace={workspace} />
    : <SettingsSection title="Code index" icon="workspace-tree"><SettingsBlock last><p className="agw-cidx-empty">Open a project to build its code index.</p></SettingsBlock></SettingsSection>}
    <IndexStorage />
  </>;
};
