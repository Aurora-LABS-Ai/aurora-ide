/**
 * Agent Window — a provider's Advanced tab: what shapes every request after
 * the connection is right.
 *
 * Four things the provider record has always carried and the runtime has
 * always honoured, but that no screen let you edit: a default temperature
 * and max output (what a model row means by "inherit"), extra request
 * parameters merged into every body, and model aliases (what you type → the
 * id sent). Custom headers live beside these too, in their own editor.
 *
 * Edits land in the store as you type for the numbers; the two text blocks
 * (JSON and alias lines) are applied on blur, because a half-typed JSON
 * object is not a value anyone wants saved.
 */

import React, { useState } from "react";

import type { LLMProvider } from "@/apps/agent/store/settings/provider-model";
import { AgwTextInput } from "./primitives";
import {
  numberOrUndefined,
  parseAliases,
  parseParams,
  stringifyAliases,
} from "./provider-advanced-fields";

type Update = (id: string, updates: Partial<LLMProvider>) => void;

export const ProviderAdvancedEditor: React.FC<{
  provider: LLMProvider;
  updateProvider: Update;
}> = ({ provider, updateProvider }) => {
  const [params, setParams] = useState(() =>
    Object.keys(provider.customParams ?? {}).length
      ? JSON.stringify(provider.customParams, null, 2)
      : "",
  );
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [aliases, setAliases] = useState(() => stringifyAliases(provider.modelAliases));

  const commitParams = () => {
    const result = parseParams(params);
    setParamsError(result.error ?? null);
    if (result.value) updateProvider(provider.id, { customParams: result.value });
  };
  const commitAliases = () => updateProvider(provider.id, { modelAliases: parseAliases(aliases) });

  return (
    <div className="agw-prov-conn agw-prov-advanced-grid">
      <label className="agw-prov-edit-field">
        <span>Default temperature</span>
        <AgwTextInput
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={provider.defaultTemperature ?? ""}
          placeholder="provider default"
          onChange={(e) =>
            updateProvider(provider.id, { defaultTemperature: numberOrUndefined(e.target.value) })
          }
        />
        <span className="agw-set-row-hint">What a model means by "inherit". Empty sends none.</span>
      </label>
      <label className="agw-prov-edit-field">
        <span>Default max output</span>
        <AgwTextInput
          type="number"
          step="256"
          min="1"
          value={provider.defaultMaxTokens ?? ""}
          placeholder="per model"
          onChange={(e) =>
            updateProvider(provider.id, { defaultMaxTokens: numberOrUndefined(e.target.value) })
          }
        />
        <span className="agw-set-row-hint">Tokens, for models that set no limit of their own.</span>
      </label>
      <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
        <span>Extra request parameters</span>
        <textarea
          className="agw-mcp-textarea"
          rows={4}
          value={params}
          placeholder={'{\n  "top_p": 0.9\n}'}
          spellCheck={false}
          onChange={(e) => {
            setParams(e.target.value);
            setParamsError(null);
          }}
          onBlur={commitParams}
        />
        {paramsError ? (
          <span className="agw-set-row-hint" style={{ color: "var(--agw-removed)" }}>
            {paramsError}
          </span>
        ) : (
          <span className="agw-set-row-hint">
            Merged into every request body for this provider. Saved when you leave the field.
          </span>
        )}
      </label>
      <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
        <span>Model aliases</span>
        <textarea
          className="agw-mcp-textarea"
          rows={3}
          value={aliases}
          placeholder={"fast=claude-3-5-haiku-20241022\nbest=claude-opus-4-5-20251101"}
          spellCheck={false}
          onChange={(e) => setAliases(e.target.value)}
          onBlur={commitAliases}
        />
        <span className="agw-set-row-hint">
          One per line, <code>alias=model id</code>. The alias is what you pick; the id is what is sent.
        </span>
      </label>
    </div>
  );
};
