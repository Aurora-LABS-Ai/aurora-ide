/**
 * Agent Window — Settings · Providers & Models (view).
 *
 * agw-native. Reads/writes the SHARED `useSettingsStore` (+ the v17 `reasoning`
 * column), so providers configured here power the IDE too.
 *
 * Layout is master–detail (not an accordion): a provider LIST on the left, the
 * selected provider's CONNECTION + MODELS on the right. Adding a model is
 * models.dev-powered — type a name, pick a match, and context window, limits,
 * capabilities, pricing, and reasoning levels auto-fill (all overridable).
 *
 * Design: Precision & Density, flat (borders + surface tint, no shadows), accent
 * reserved for active/status. No native form controls — the type picker is a
 * custom select.
 */

import React, { useEffect, useMemo, useState } from "react";

import { useSettingsStore, type LLMModel, type LLMProvider } from "../../store/useSettingsStore";
import { lookupModel, type ModelsDevEntry } from "../../services/models-dev";
import { isAtlasCloudProvider } from "../../services/atlascloud";
import { isCodexProvider } from "../../services/codex";
import { AgentIcon } from "../shared/AgentIcon";
import { AtlasCloudUsageCard } from "./AtlasCloudUsageCard";
import { CodexUsageCard } from "./CodexUsageCard";
import { AgwButton, AgwPill, AgwSegmented, AgwSwitch, AgwTextInput } from "./primitives";

function hasAnyKey(p: LLMProvider): boolean {
  if (p.apiKey.trim().length > 0) return true;
  return !!p.apiKeys && p.apiKeys.some((k) => k.trim().length > 0);
}

function providerReady(p: LLMProvider): boolean {
  if (!p.enabled) return false;
  const local = /localhost|127\.0\.0\.1/.test(p.baseUrl.toLowerCase());
  return local || p.requiresApiKey === false || hasAnyKey(p);
}

/**
 * Compact a context-window token count for the model chip: millions collapse to
 * `M` (1_000_000 → "1M", 1_500_000 → "1.5M"), everything else to `K`. Avoids
 * the "1000K" that reads worse than "1M".
 */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** Count of distinct non-blank keys across the single field + pool. */
function keyPoolSize(p: LLMProvider): number {
  const set = new Set<string>();
  if (p.apiKey.trim()) set.add(p.apiKey.trim());
  for (const k of p.apiKeys ?? []) if (k.trim()) set.add(k.trim());
  return set.size;
}

/**
 * Models whose barren metadata we've already backfilled from models.dev this
 * session. Module-level (NOT a per-mount ref) so reopening settings doesn't
 * re-run enrichment and overwrite the user's manual edits.
 */
const enrichedModelIds = new Set<string>();

function entryToModelInit(e: ModelsDevEntry): Omit<LLMModel, "id" | "providerId" | "sortOrder"> {
  return {
    modelKey: e.modelKey,
    label: e.name,
    contextWindow: e.contextWindow,
    maxOutputTokens: e.maxOutputTokens,
    supportsVision: e.supportsVision,
    supportsThinking: e.supportsThinking,
    supportsToolStream: e.supportsToolStream,
    priceCacheHitPerMtok: e.priceCacheHitPerMtok,
    priceCacheMissPerMtok: e.priceCacheMissPerMtok,
    priceOutputPerMtok: e.priceOutputPerMtok,
    reasoning: e.reasoning,
    enabled: true,
  };
}

// ── Extra request-body editor (manual escape hatch) ──────────────────────────

/**
 * Per-model "extra request fields" editor — a friendly key/value list (NOT a raw
 * JSON blob). Each row is one field added verbatim to this model's request body.
 * Values are smart-parsed: `high` → string, `123` → number, `true` → boolean,
 * `{"type":"enabled"}` → object; anything that isn't valid JSON stays text. So a
 * user never hits an "invalid JSON" wall. Empty rows are ignored.
 */
const ExtraBodyEditor: React.FC<{
  model: LLMModel;
  updateModel: (id: string, updates: Partial<LLMModel>) => void;
}> = ({ model, updateModel }) => {
  type Row = { k: string; v: string };
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(model.extraBody ?? {}).map(([k, val]) => ({
      k,
      v: typeof val === "string" ? val : JSON.stringify(val),
    })),
  );

  const persist = (next: Row[]) => {
    const obj: Record<string, unknown> = {};
    for (const { k, v } of next) {
      const key = k.trim();
      if (!key) continue;
      const t = v.trim();
      // Smart value: detect number / boolean / null / JSON; else keep as text.
      let value: unknown = v;
      if (t.length > 0) {
        try {
          value = JSON.parse(t);
        } catch {
          value = v;
        }
      } else {
        value = "";
      }
      obj[key] = value;
    }
    updateModel(model.id, {
      extraBody: Object.keys(obj).length > 0 ? obj : undefined,
    });
  };

  const setRow = (i: number, patch: Partial<Row>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setRows(next);
    persist(next);
  };
  const addRow = () => setRows((r) => [...r, { k: "", v: "" }]);
  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    persist(next);
  };

  return (
    <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
      <span>Extra request fields</span>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <AgwTextInput
            value={r.k}
            placeholder="field — e.g. reasoning_effort"
            onChange={(e) => setRow(i, { k: e.target.value })}
            style={{ flex: "0 0 40%", minWidth: 0 }}
          />
          <AgwTextInput
            value={r.v}
            placeholder={'value — e.g. high  or  {"type":"enabled"}'}
            onChange={(e) => setRow(i, { v: e.target.value })}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Remove field"
            aria-label="Remove field"
            onClick={() => removeRow(i)}
          >
            <AgentIcon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        style={{
          alignSelf: "flex-start",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--agw-text-muted)",
          background: "var(--agw-surface)",
          border: "1px dashed var(--agw-border-strong)",
          borderRadius: "var(--agw-radius-sm)",
          cursor: "pointer",
        }}
      >
        <AgentIcon name="plus" size={13} />
        Add field
      </button>
      <span style={{ fontSize: 11, color: "var(--agw-text-subtle)" }}>
        Optional. Sent as-is in this model's request body every turn. Numbers,
        true/false, and JSON are detected automatically — anything else is text.
      </span>
    </div>
  );
};

// ── Extra request-headers editor (provider-level escape hatch) ───────────────

/**
 * Per-provider "extra headers" editor — a key/value list. Each row is one HTTP
 * header sent verbatim on every request to this provider (OpenAI-compatible and
 * Anthropic-compatible alike). Applied on top of the auth header the format
 * already sets, so a user can add routing/org/beta headers a provider needs
 * (e.g. `HTTP-Referer`, `anthropic-beta`, `x-organization`) without Aurora
 * hard-coding them. Empty rows are ignored; values are plain strings.
 */
const CustomHeadersEditor: React.FC<{
  provider: LLMProvider;
  updateProvider: (id: string, updates: Partial<LLMProvider>) => void;
}> = ({ provider, updateProvider }) => {
  type Row = { k: string; v: string };
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(provider.customHeaders ?? {}).map(([k, v]) => ({ k, v })),
  );

  const persist = (next: Row[]) => {
    const obj: Record<string, string> = {};
    for (const { k, v } of next) {
      const key = k.trim();
      if (!key) continue;
      obj[key] = v;
    }
    updateProvider(provider.id, {
      customHeaders: Object.keys(obj).length > 0 ? obj : undefined,
    });
  };

  const setRow = (i: number, patch: Partial<Row>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setRows(next);
    persist(next);
  };
  const addRow = () => setRows((r) => [...r, { k: "", v: "" }]);
  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    persist(next);
  };

  return (
    <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
      <span>Extra headers</span>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <AgwTextInput
            value={r.k}
            placeholder="header — e.g. anthropic-beta"
            onChange={(e) => setRow(i, { k: e.target.value })}
            style={{ flex: "0 0 40%", minWidth: 0 }}
          />
          <AgwTextInput
            value={r.v}
            placeholder="value"
            onChange={(e) => setRow(i, { v: e.target.value })}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Remove header"
            aria-label="Remove header"
            onClick={() => removeRow(i)}
          >
            <AgentIcon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        style={{
          alignSelf: "flex-start",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--agw-text-muted)",
          background: "var(--agw-surface)",
          border: "1px dashed var(--agw-border-strong)",
          borderRadius: "var(--agw-radius-sm)",
          cursor: "pointer",
        }}
      >
        <AgentIcon name="plus" size={13} />
        Add header
      </button>
      <span style={{ fontSize: 11, color: "var(--agw-text-subtle)" }}>
        Optional. Sent verbatim with every request to this provider, on top of the
        API-key header. Useful for org, beta, or routing headers.
      </span>
    </div>
  );
};

// ── API-key pool editor (round-robin + failover) ─────────────────────────────

/**
 * Per-provider "extra API keys" editor — a list of ADDITIONAL keys layered on
 * top of the single API-key field above. When two or more distinct keys exist
 * across both, the Rust runtime treats them as a POOL: it rotates them
 * round-robin per turn and, if one returns 401 / 429 / 5xx before any content
 * streams, retries the identical request with the next key. Generic across
 * providers — the first consumer is AgentRouter (users run several accounts).
 * Blank rows are ignored.
 */
const ApiKeyPoolEditor: React.FC<{
  provider: LLMProvider;
  updateProvider: (id: string, updates: Partial<LLMProvider>) => void;
}> = ({ provider, updateProvider }) => {
  const [rows, setRows] = useState<string[]>(() => provider.apiKeys ?? []);
  const [reveal, setReveal] = useState(false);

  const persist = (next: string[]) => {
    const cleaned = next.filter((k) => k.trim().length > 0);
    updateProvider(provider.id, {
      apiKeys: cleaned.length > 0 ? cleaned : undefined,
    });
  };
  const setRow = (i: number, v: string) => {
    const next = rows.map((r, idx) => (idx === i ? v : r));
    setRows(next);
    persist(next);
  };
  const addRow = () => setRows((r) => [...r, ""]);
  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    persist(next);
  };

  const poolSize = keyPoolSize(provider);

  return (
    <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        Backup keys
        {poolSize > 1 && <AgwPill tone="success">{poolSize} keys</AgwPill>}
      </span>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <AgwTextInput
            type={reveal ? "text" : "password"}
            value={r}
            placeholder="sk-…"
            spellCheck={false}
            onChange={(e) => setRow(i, e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Remove key"
            aria-label="Remove key"
            onClick={() => removeRow(i)}
          >
            <AgentIcon name="close" size={13} />
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={addRow}
          style={{
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--agw-text-muted)",
            background: "var(--agw-surface)",
            border: "1px dashed var(--agw-border-strong)",
            borderRadius: "var(--agw-radius-sm)",
            cursor: "pointer",
          }}
        >
          <AgentIcon name="plus" size={13} />
          Add key
        </button>
        {rows.length > 0 && (
          <button
            type="button"
            className="agw-prov-icon-btn"
            title={reveal ? "Hide keys" : "Show keys"}
            onClick={() => setReveal((v) => !v)}
          >
            <AgentIcon name={reveal ? "inspect" : "browser"} size={14} />
          </button>
        )}
      </div>
      <span style={{ fontSize: 11, color: "var(--agw-text-subtle)" }}>
        Optional. If one key is busy or fails, the next one is used.
      </span>
    </div>
  );
};

// ── Add-model row: type a model id → it auto-fills from models.dev ────────────

const AddModelRow: React.FC<{ providerId: string; providerType?: string }> = ({
  providerId,
  providerType,
}) => {
  const addModel = useSettingsStore((s) => s.addModel);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const add = async () => {
    const key = id.trim();
    if (!key || busy) return;
    setBusy(true);
    setNote(null);
    try {
      // Pull the model's config straight from models.dev and fill the fields.
      const entry = await lookupModel(key, providerType);
      if (entry) {
        // Use models.dev ONLY for metadata (context, pricing, capabilities,
        // reasoning). The model id is whatever the user typed, verbatim — never
        // models.dev's re-cased canonical id, because `modelKey` is the exact
        // string sent to the provider API.
        addModel(providerId, { ...entryToModelInit(entry), modelKey: key });
      } else {
        // Unknown to models.dev — add with safe defaults; user can override.
        addModel(providerId, {
          modelKey: key,
          supportsVision: false,
          supportsThinking: false,
          supportsToolStream: true,
          enabled: true,
        });
        setNote("Not found on models.dev — added with defaults. Override its fields below.");
      }
      setId("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agw-prov-addwrap">
      <div className="agw-prov-addrow">
        <div className="agw-prov-add-field">
          <AgentIcon name="plus" size={14} style={{ color: "var(--agw-text-subtle)" }} />
          <input
            className="agw-prov-add-input"
            placeholder="Model ID — e.g. gpt-5, claude-sonnet-4-5, deepseek-chat"
            value={id}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
        </div>
        <AgwButton variant="primary" icon="plus" onClick={() => void add()} disabled={busy || !id.trim()}>
          {busy ? "Adding…" : "Add"}
        </AgwButton>
      </div>
      {note && <div className="agw-prov-add-note">{note}</div>}
    </div>
  );
};

// ── Model row ────────────────────────────────────────────────────────────────

const ModelRow: React.FC<{ model: LLMModel; active: boolean; onActivate: () => void }> = ({
  model,
  active,
  onActivate,
}) => {
  const updateModel = useSettingsStore((s) => s.updateModel);
  const deleteModel = useSettingsStore((s) => s.deleteModel);
  const [editing, setEditing] = useState(false);
  const reasoning = model.reasoning;
  const ctx = model.contextWindow ? formatContextWindow(model.contextWindow) : null;
  const price =
    model.priceOutputPerMtok != null
      ? `$${model.priceCacheMissPerMtok ?? "?"} / $${model.priceOutputPerMtok}`
      : null;

  return (
    <div className="agw-prov-model" data-active={active || undefined}>
      <div className="agw-prov-model-top">
        <button type="button" className="agw-prov-model-main" onClick={onActivate} title="Use this model">
          <span className="agw-prov-model-radio" data-on={active || undefined} />
          <span className="agw-prov-model-name">{model.label || model.modelKey}</span>
          {active && <AgwPill tone="success">Active</AgwPill>}
        </button>
        <div className="agw-prov-model-actions">
          {reasoning?.type === "effort" && reasoning.levels?.length ? (
            <AgwSegmented
              ariaLabel="Reasoning level"
              value={String(reasoning.default ?? reasoning.levels[reasoning.levels.length - 1])}
              options={reasoning.levels.map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) }))}
              onChange={(lvl) => updateModel(model.id, { reasoning: { ...reasoning, default: lvl } })}
            />
          ) : null}
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Override fields"
            aria-pressed={editing}
            onClick={() => setEditing((v) => !v)}
            style={editing ? { color: "var(--agw-accent)" } : undefined}
          >
            <AgentIcon name="sliders" size={14} />
          </button>
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Remove model"
            onClick={() => deleteModel(model.id)}
          >
            <AgentIcon name="close" size={14} />
          </button>
        </div>
      </div>

      <div className="agw-prov-model-chips">
        <span className="agw-prov-key">{model.modelKey}</span>
        {ctx && <span className="agw-prov-meta-dot">{ctx} ctx</span>}
        {price && <span className="agw-prov-meta-dot">{price}</span>}
        {model.supportsVision && <span className="agw-prov-chip">Vision</span>}
        {model.supportsToolStream && <span className="agw-prov-chip">Tools</span>}
        {reasoning && (
          <span className="agw-prov-chip">
            {reasoning.type === "effort"
              ? `Reasoning · ${reasoning.default}`
              : reasoning.type === "budget" && typeof reasoning.default === "number"
                ? `Reasoning · ${Math.round(reasoning.default / 100) / 10}k`.replace(".0k", "k")
                : "Reasoning"}
          </span>
        )}
      </div>

      {editing && (
        <div className="agw-prov-edit">
          <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>Display name</span>
            <AgwTextInput
              value={model.label ?? ""}
              placeholder={model.modelKey}
              onChange={(e) =>
                updateModel(model.id, { label: e.target.value || undefined })
              }
            />
          </label>
          <label className="agw-prov-edit-field">
            <span>Context window</span>
            <AgwTextInput
              type="number"
              value={model.contextWindow ?? ""}
              placeholder="inherit"
              onChange={(e) =>
                updateModel(model.id, { contextWindow: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="agw-prov-edit-field">
            <span>Max output</span>
            <AgwTextInput
              type="number"
              value={model.maxOutputTokens ?? ""}
              placeholder="inherit"
              onChange={(e) =>
                updateModel(model.id, { maxOutputTokens: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="agw-prov-edit-field">
            <span>Input price · per 1M</span>
            <AgwTextInput
              type="number"
              value={model.priceCacheMissPerMtok ?? ""}
              placeholder="—"
              onChange={(e) =>
                updateModel(model.id, {
                  priceCacheMissPerMtok: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label className="agw-prov-edit-field">
            <span>Output price · per 1M</span>
            <AgwTextInput
              type="number"
              value={model.priceOutputPerMtok ?? ""}
              placeholder="—"
              onChange={(e) =>
                updateModel(model.id, {
                  priceOutputPerMtok: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <div className="agw-prov-edit-toggles">
            <button
              type="button"
              className="agw-prov-cap"
              data-on={model.supportsVision || undefined}
              onClick={() => updateModel(model.id, { supportsVision: !model.supportsVision })}
            >
              Vision
            </button>
            <button
              type="button"
              className="agw-prov-cap"
              data-on={model.supportsToolStream || undefined}
              onClick={() => updateModel(model.id, { supportsToolStream: !model.supportsToolStream })}
            >
              Tools
            </button>
          </div>

          {/* Reasoning configurator. Auto-detected from models.dev on add; set or
              correct it here. Effort exposes selectable tiers; Budget a token range. */}
          <div className="agw-prov-reason" style={{ gridColumn: "1 / -1" }}>
            <span className="agw-prov-edit-field" style={{ gap: 6 }}>
              <span>Reasoning</span>
              <AgwSegmented
                ariaLabel="Reasoning type"
                value={(reasoning?.type ?? "none") as "none" | "toggle" | "effort" | "budget"}
                options={[
                  { value: "none", label: "None" },
                  { value: "toggle", label: "On/off" },
                  { value: "effort", label: "Effort" },
                  { value: "budget", label: "Budget" },
                ]}
                onChange={(t) => {
                  if (t === "none") return updateModel(model.id, { reasoning: undefined, supportsThinking: false });
                  if (t === "toggle")
                    return updateModel(model.id, { reasoning: { type: "toggle", default: true }, supportsThinking: true });
                  // `default` carries a TIER for effort models and a TOKEN COUNT
                  // for budget models. Switching type must not drag the old
                  // shape across, or an effort model ends up sending
                  // `reasoning_effort: "8000"` (and a budget model a budget of
                  // "medium", which reads as no budget at all).
                  if (t === "effort") {
                    const levels = reasoning?.levels?.length
                      ? reasoning.levels
                      : ["low", "medium", "high"];
                    const carried =
                      typeof reasoning?.default === "string" && levels.includes(reasoning.default)
                        ? reasoning.default
                        : levels.includes("medium")
                          ? "medium"
                          : levels[levels.length - 1];
                    return updateModel(model.id, {
                      reasoning: { type: "effort", levels, default: carried },
                      supportsThinking: true,
                    });
                  }
                  return updateModel(model.id, {
                    reasoning: {
                      type: "budget",
                      min: reasoning?.min ?? 1024,
                      max: reasoning?.max ?? 32000,
                      default: typeof reasoning?.default === "number" ? reasoning.default : 8000,
                    },
                    supportsThinking: true,
                  });
                }}
              />
            </span>

            {reasoning?.type === "effort" && (
              <label className="agw-prov-edit-field">
                <span>Levels (comma-separated)</span>
                <AgwTextInput
                  value={(reasoning.levels ?? []).join(", ")}
                  placeholder="low, medium, high"
                  onChange={(e) => {
                    const levels = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                    const def =
                      levels.includes(String(reasoning.default)) ? reasoning.default : levels[levels.length - 1];
                    updateModel(model.id, { reasoning: { ...reasoning, levels, default: def } });
                  }}
                />
              </label>
            )}

            {reasoning?.type === "effort" && (
              <label className="agw-prov-edit-field">
                <span>Reasoning on/off</span>
                <button
                  type="button"
                  className="agw-prov-cap"
                  data-on={reasoning.toggleable !== false || undefined}
                  onClick={() =>
                    updateModel(model.id, {
                      reasoning: { ...reasoning, toggleable: reasoning.toggleable === false },
                    })
                  }
                  title="Turn OFF for a natively-reasoning model that can't be disabled — the composer then shows only the effort selector, no on/off."
                >
                  {reasoning.toggleable !== false ? "Has on/off switch" : "Always on (native)"}
                </button>
              </label>
            )}

            {reasoning?.type === "budget" && (
              <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
                <span>Default budget</span>
                <span className="agw-agent-range">
                  <input
                    className="agw-set-range"
                    type="range"
                    min={Math.max(1024, reasoning.min ?? 1024)}
                    max={Math.max(
                      (reasoning.min ?? 1024) + 1000,
                      reasoning.max ?? model.maxOutputTokens ?? 32000,
                    )}
                    step={500}
                    value={Math.min(
                      Math.max(
                        (reasoning.min ?? 1024) + 1000,
                        reasoning.max ?? model.maxOutputTokens ?? 32000,
                      ),
                      Math.max(
                        Math.max(1024, reasoning.min ?? 1024),
                        typeof reasoning.default === "number" ? reasoning.default : 8000,
                      ),
                    )}
                    aria-label="Default thinking budget"
                    onChange={(e) =>
                      updateModel(model.id, {
                        reasoning: { ...reasoning, default: Number(e.target.value) },
                      })
                    }
                  />
                  <AgwPill tone="neutral">
                    {(typeof reasoning.default === "number"
                      ? reasoning.default
                      : 8000
                    ).toLocaleString()}
                  </AgwPill>
                </span>
                <span className="agw-set-row-hint">
                  Tokens this model may spend thinking before it answers. New chats start here;
                  change it per chat from the model picker.
                </span>
              </label>
            )}

            {reasoning?.type === "budget" && (
              <div className="agw-prov-edit" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                <label className="agw-prov-edit-field">
                  <span>Min budget</span>
                  <AgwTextInput
                    type="number"
                    value={reasoning.min ?? ""}
                    onChange={(e) =>
                      updateModel(model.id, { reasoning: { ...reasoning, min: e.target.value ? Number(e.target.value) : undefined } })
                    }
                  />
                </label>
                <label className="agw-prov-edit-field">
                  <span>Max budget</span>
                  <AgwTextInput
                    type="number"
                    value={reasoning.max ?? ""}
                    onChange={(e) =>
                      updateModel(model.id, { reasoning: { ...reasoning, max: e.target.value ? Number(e.target.value) : undefined } })
                    }
                  />
                </label>
              </div>
            )}
          </div>

          <ExtraBodyEditor model={model} updateModel={updateModel} />
        </div>
      )}
    </div>
  );
};

// ── Detail pane ──────────────────────────────────────────────────────────────

const ProviderDetail: React.FC<{
  provider: LLMProvider;
  models: LLMModel[];
  selectedModel: string;
  onDeleted: () => void;
}> = ({ provider, models, selectedModel, onDeleted }) => {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const [showKey, setShowKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const atlas = isAtlasCloudProvider(provider);
  const codex = isCodexProvider(provider);

  // Remove = delete for custom providers, hide-and-persist for built-in
  // presets (which would otherwise re-seed on every launch). Two-click
  // confirm so it isn't a one-tap destructive action.
  const doRemove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    removeProvider(provider.id);
    onDeleted();
  };
  const removeLabel = provider.isCustom ? "Delete provider" : "Remove from list";

  return (
    <div className="agw-prov-detail" data-atlas={atlas || undefined}>
      {/* Atlas and Codex own their identity + enable control inside their
          usage cards, so the generic "name / openai" head would be
          redundant — hide it. */}
      {atlas ? (
        <AtlasCloudUsageCard
          provider={provider}
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : codex ? (
        <CodexUsageCard
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : (
        <div className="agw-prov-detail-head">
          <span className="agw-prov-avatar">
            {(provider.nickname || provider.name || "?").trim().charAt(0).toUpperCase()}
          </span>
          <div className="agw-prov-detail-titles">
            <div className="agw-prov-detail-name">{provider.nickname || provider.name}</div>
            <div className="agw-prov-detail-sub">{provider.providerType ?? "custom"}</div>
          </div>
          <AgwSwitch
            checked={provider.enabled}
            onChange={(v) => updateProvider(provider.id, { enabled: v })}
            ariaLabel={`Enable ${provider.name}`}
          />
        </div>
      )}

      {/* Connection. Codex has none to edit — endpoint and auth are managed
          by the sign-in card above (the Rust adapter pins the URL). */}
      {!codex && (
      <div className="agw-prov-conn">
        {provider.isCustom && (
          <>
            <label className="agw-prov-edit-field">
              <span>Name</span>
              <AgwTextInput value={provider.name} onChange={(e) => updateProvider(provider.id, { name: e.target.value })} />
            </label>
            <label className="agw-prov-edit-field">
              <span>API type</span>
              <AgwSegmented<"openai" | "openai-responses" | "anthropic">
                ariaLabel="Provider API type"
                value={
                  provider.providerType === "anthropic" || provider.providerType === "openai-responses"
                    ? provider.providerType
                    : "openai"
                }
                options={[
                  { value: "openai", label: "OpenAI compatible" },
                  { value: "openai-responses", label: "OpenAI Responses" },
                  { value: "anthropic", label: "Anthropic compatible" },
                ]}
                onChange={(t) => updateProvider(provider.id, { providerType: t })}
              />
            </label>
          </>
        )}
        <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
          <span>Base URL</span>
          <AgwTextInput
            value={provider.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
          />
        </label>
        {provider.requiresApiKey !== false && (
          <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>API key</span>
            <div className="agw-prov-key-row">
              <AgwTextInput
                type={showKey ? "text" : "password"}
                value={provider.apiKey}
                placeholder="sk-…"
                onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
              />
              <button
                type="button"
                className="agw-prov-icon-btn"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "Hide" : "Show"}
              >
                <AgentIcon name={showKey ? "inspect" : "browser"} size={14} />
              </button>
            </div>
          </label>
        )}
        {provider.requiresApiKey !== false && (
          <ApiKeyPoolEditor provider={provider} updateProvider={updateProvider} />
        )}
        <CustomHeadersEditor provider={provider} updateProvider={updateProvider} />
      </div>
      )}

      {/* Models */}
      <div className="agw-prov-models-head">
        Models <span className="agw-prov-models-count">{models.length}</span>
      </div>
      <p className="agw-prov-models-hint">
        New models auto-fill from models.dev — context window, limits, capabilities, pricing, and
        reasoning levels. Everything is overridable.
      </p>
      <div className="agw-prov-models agw-scroll">
        {models.length === 0 ? (
          <div className="agw-prov-empty">No models yet — add one below.</div>
        ) : (
          models.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              active={selectedModel === `${provider.id}:${m.modelKey}`}
              onActivate={() => setSelectedModel(`${provider.id}:${m.modelKey}`)}
            />
          ))
        )}
      </div>
      <AddModelRow providerId={provider.id} providerType={provider.providerType} />

      {/* Remove — deletes a custom provider, or drops a built-in preset so it
          stops re-seeding. Two-click confirm; the second click commits. */}
      <div className="agw-prov-detail-danger">
        <button
          type="button"
          className="agw-prov-remove-btn"
          data-confirm={confirmRemove || undefined}
          onClick={doRemove}
          onMouseLeave={() => setConfirmRemove(false)}
          title={removeLabel}
        >
          <AgentIcon name="close" size={13} />
          {confirmRemove ? "Click again" : removeLabel}
        </button>
      </div>
    </div>
  );
};

// ── Page (master–detail) ─────────────────────────────────────────────────────

export const ProvidersSettings: React.FC = () => {
  const providers = useSettingsStore((s) => s.providers);
  const models = useSettingsStore((s) => s.models);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const addCustomProvider = useSettingsStore((s) => s.addCustomProvider);
  const updateModel = useSettingsStore((s) => s.updateModel);

  const [activeId, setActiveId] = useState<string | null>(null);

  // Backfill a BARREN preset/seeded model's missing metadata from models.dev,
  // exactly ONCE per model per session. Reasoning is NO LONGER a trigger and is
  // NEVER re-derived here: it's the user's to configure, so models.dev must not
  // reach in and overwrite it (or restore it after the user clears it). The
  // tracking set is module-level (`enrichedModelIds`) — NOT a per-mount ref — so
  // navigating away from settings and back can't re-run enrichment and clobber
  // your edits.
  useEffect(() => {
    const missing = models.filter(
      (m) => !enrichedModelIds.has(m.id) && m.contextWindow == null,
    );
    if (missing.length === 0) return;
    let alive = true;
    void (async () => {
      for (const m of missing) {
        enrichedModelIds.add(m.id);
        const e = await lookupModel(m.modelKey);
        if (!alive || !e) continue;
        // Fill ONLY genuinely-empty fields; never touch `reasoning` or flip a
        // capability the user may have turned off.
        updateModel(m.id, {
          contextWindow: m.contextWindow ?? e.contextWindow,
          maxOutputTokens: m.maxOutputTokens ?? e.maxOutputTokens,
          priceCacheHitPerMtok: m.priceCacheHitPerMtok ?? e.priceCacheHitPerMtok,
          priceCacheMissPerMtok: m.priceCacheMissPerMtok ?? e.priceCacheMissPerMtok,
          priceOutputPerMtok: m.priceOutputPerMtok ?? e.priceOutputPerMtok,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [models, updateModel]);

  // Keep a valid selection as the provider list changes.
  const selected = providers.find((p) => p.id === activeId) ?? providers[0] ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep a valid provider selected
    if (selected && selected.id !== activeId) setActiveId(selected.id);
  }, [selected, activeId]);

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, LLMModel[]>();
    for (const m of models) {
      const arr = map.get(m.providerId) ?? [];
      arr.push(m);
      map.set(m.providerId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
    return map;
  }, [models]);

  const addProvider = () => {
    const id = addCustomProvider({
      name: "New provider",
      baseUrl: "",
      apiKey: "",
      model: "",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsThinking: false,
      supportsToolStream: true,
      providerType: "openai",
      requiresApiKey: true,
      enabled: true,
    });
    setActiveId(id);
  };

  return (
    <div className="agw-prov-page">
      {/* Provider sidebar — full height, flush with the content edge. */}
      <aside className="agw-prov-side">
        <div className="agw-prov-side-head">
          <span>Providers</span>
          <span className="agw-prov-side-count">{providers.length}</span>
        </div>
        <div className="agw-prov-side-scroll agw-scroll">
          {providers.map((p) => {
            const ready = providerReady(p);
            const count = modelsByProvider.get(p.id)?.length ?? 0;
            return (
              <button
                key={p.id}
                type="button"
                className="agw-prov-item"
                data-active={p.id === selected?.id || undefined}
                onClick={() => setActiveId(p.id)}
              >
                <span className="agw-prov-avatar agw-prov-avatar-sm">
                  {(p.nickname || p.name || "?").trim().charAt(0).toUpperCase()}
                </span>
                <span className="agw-prov-item-text">
                  <span className="agw-prov-item-name">{p.nickname || p.name}</span>
                  <span className="agw-prov-item-sub">
                    {count} {count === 1 ? "model" : "models"}
                  </span>
                </span>
                <span
                  className="agw-prov-status-dot"
                  data-tone={ready ? "ready" : "off"}
                  title={ready ? "Ready" : "Needs API key"}
                />
              </button>
            );
          })}
          {providers.length === 0 && (
            <div className="agw-prov-empty">No providers yet.</div>
          )}
        </div>
        <div className="agw-prov-list-foot">
          <AgwButton variant="primary" icon="plus" onClick={addProvider}>
            Add provider
          </AgwButton>
        </div>
      </aside>

      {/* Detail pane — the selected provider's connection + models. */}
      <section className="agw-prov-main agw-scroll">
        <div className="agw-prov-main-inner">
          {selected ? (
            <ProviderDetail
              key={selected.id}
              provider={selected}
              models={modelsByProvider.get(selected.id) ?? []}
              selectedModel={selectedModel}
              onDeleted={() => setActiveId(null)}
            />
          ) : (
            <div className="agw-prov-detail agw-prov-detail-empty">
              <AgentIcon name="providers" size={24} style={{ color: "var(--agw-text-subtle)" }} />
              <div>No providers yet.</div>
              <AgwButton variant="primary" icon="plus" onClick={addProvider}>
                Add provider
              </AgwButton>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
