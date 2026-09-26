import React, { useEffect, useState } from "react";
import type { IndexSettings } from "@/apps/agent/services/code-index/code-index";
import { AgwButton, SettingsRow, SettingsSection } from "../primitives";

export const IndexSearchSettings: React.FC<{
  settings: IndexSettings; disabled: boolean; onDirty: (value: boolean) => void; onSave: (value: IndexSettings) => Promise<void>;
}> = ({ settings, disabled, onDirty, onSave }) => {
  const [results, setResults] = useState(String(settings.searchResults));
  const [bytes, setBytes] = useState(String(settings.searchBytes));
  const dirty = Number(results) !== settings.searchResults || Number(bytes) !== settings.searchBytes;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  return <SettingsSection title="Search results" icon="search" description="Limit how much matching source the agent receives per search. Saved for this project; applies to the next search.">
    <form onSubmit={(event) => { event.preventDefault(); void onSave({ ...settings, searchResults: Number(results), searchBytes: Number(bytes) }); }}>
      <SettingsRow label="Maximum results" hint="Between 1 and 20 matching files.">
        <input className="agw-set-input agw-cidx-number" aria-label="Maximum results" type="number" min={1} max={20} step={1} required value={results} disabled={disabled}
          onChange={(event) => setResults(event.target.value)} />
      </SettingsRow>
      <SettingsRow label="Source output limit" hint="Combined source text in bytes, from 2,000 to 64,000. Longer functions are shown as excerpts with line numbers.">
        <input className="agw-set-input agw-cidx-number" aria-label="Source output limit" type="number" min={2000} max={64000} step={1} required value={bytes} disabled={disabled}
          onChange={(event) => setBytes(event.target.value)} />
      </SettingsRow>
      <SettingsRow label="Save search settings" last><AgwButton type="submit" disabled={disabled || !dirty}>Save settings</AgwButton></SettingsRow>
    </form>
  </SettingsSection>;
};
