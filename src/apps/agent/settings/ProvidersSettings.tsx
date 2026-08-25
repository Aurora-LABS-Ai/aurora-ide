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
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";

import { useSettingsStore, type LLMModel, type LLMProvider } from "@/kernel/store/useSettingsStore";
import { lookupModel, type ModelsDevEntry } from "@/apps/agent/services/providers/models-dev";
import { isAtlasCloudProvider } from "@/apps/agent/services/providers/atlascloud";
import { isCodexProvider } from "@/apps/agent/services/providers/codex";
import { isCursorProvider } from "@/apps/agent/services/providers/cursor";
import {
  defaultOpenCodeWire,
  isOpenCodeProvider,
  openCodeWireFor,
  OPENCODE_PROVIDER_ID,
  OPENCODE_WIRES,
  type OpenCodeWire,
} from "@/apps/agent/services/providers/opencode";
import { groupProviders, isBuiltInProvider } from "@/apps/agent/services/providers/built-in";
import {
  loadPinnedProviders,
  loadProviderGroupsOpen,
  savePinnedProviders,
  saveProviderGroupsOpen,
  type ProviderGroupsOpen,
} from "./provider-pins";
import {
  isKenariProvider,
  kenariWire,
  KENARI_WIRES,
  type KenariWire,
} from "@/apps/agent/services/providers/kenari";
import { ProviderAvatar } from "./ProviderAvatar";
import { AgentIcon } from "../shared/AgentIcon";
import { ModelTestButton } from "./ModelTestButton";
import { AtlasCloudUsageCard } from "./AtlasCloudUsageCard";
import { CodexUsageCard } from "./CodexUsageCard";
import { KenariUsageCard } from "./KenariUsageCard";
import { CursorProviderCard } from "./CursorProviderCard";
import { OpenCodeProviderCard } from "./OpenCodeProviderCard";
import { AgwButton, AgwPill, AgwSegmented, AgwSwitch, AgwTextInput } from "./primitives";

/**
 * Smooth height/opacity glide for a collapsible rail group. Mounts/unmounts
 * its children but animates the transition instead of snapping — the same
 * helper the left rail's Projects section uses (kept local for the same
 * reason: importing it from the rail would pull the whole rail module in).
 */
const Collapse: React.FC<{ open: boolean; children: React.ReactNode }> = ({
  open,
  children,
}) => (
  <AnimatePresence initial={false}>
    {open && (
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        // relative: rows leave via AnimatePresence popLayout, which positions
        // the exiting row absolutely against its nearest positioned ancestor —
        // without this it would fade out anchored to the wrong box.
        style={{ overflow: "hidden", position: "relative" }}
      >
        {children}
      </motion.div>
    )}
  </AnimatePresence>
);

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
    priceCacheWritePerMtok: e.priceCacheWritePerMtok,
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
          fontSize: "var(--agw-fs-label)",
          fontWeight: "var(--agw-fw-medium)",
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
      <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
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
          fontSize: "var(--agw-fs-label)",
          fontWeight: "var(--agw-fw-medium)",
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
      <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
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
            fontSize: "var(--agw-fs-label)",
            fontWeight: "var(--agw-fw-medium)",
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
            aria-label={reveal ? "Hide backup keys" : "Show backup keys"}
            aria-pressed={reveal}
            title={reveal ? "Hide keys" : "Show keys"}
            onClick={() => setReveal((v) => !v)}
          >
            <AgentIcon name={reveal ? "eye-off" : "eye"} size={14} />
          </button>
        )}
      </div>
      <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
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

const ModelRow: React.FC<{
  model: LLMModel;
  active: boolean;
  onActivate: () => void;
  /** The provider's own default, shown as what an empty Temperature inherits. */
  providerTemperature?: number;
}> = ({ model, active, onActivate, providerTemperature }) => {
  const updateModel = useSettingsStore((s) => s.updateModel);
  const deleteModel = useSettingsStore((s) => s.deleteModel);
  const [editing, setEditing] = useState(false);
  const reasoning = model.reasoning;
  const isOpenCode = model.providerId === OPENCODE_PROVIDER_ID;
  const ocDefault = defaultOpenCodeWire(model.modelKey);
  const ocWire = openCodeWireFor(model);
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
          <ModelTestButton model={model} />
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

      {/* OpenCode Go picks its wire per MODEL, so the control belongs on the
          row. It gets its own line rather than a place beside the reasoning
          levels for two reasons, both learned the hard way: a model with six
          reasoning levels plus three formats overflows the top row and squeezes
          the model's own name to nothing, and two unlabelled segmented controls
          side by side give no clue which is which.

          Not folded into Override fields, though: this is the first thing to
          reach for when a model errors, and the plan gains models faster than
          the defaults table can be updated. */}
      {isOpenCode && (
        <div className="agw-prov-model-wire">
          <span className="agw-prov-model-wire-label">Format</span>
          <AgwSegmented<OpenCodeWire>
            ariaLabel={`API format for ${model.label || model.modelKey}`}
            value={ocWire}
            options={OPENCODE_WIRES.map((w) => ({ value: w.value, label: w.label }))}
            onChange={(next) =>
              updateModel(model.id, {
                // Choosing the default again clears the override, so a row the
                // user never really changed keeps tracking the table instead of
                // freezing on today's answer.
                providerType: next === ocDefault ? undefined : next,
              })
            }
          />
          {/* Shown only on a row that differs from its default, so the changed
              ones stand out down a long list. An action rather than a sentence:
              it names the default AND is the way back to it, where a line of
              prose would only describe the situation and leave the user to work
              out which of the three to click. */}
          {ocWire !== ocDefault && (
            <button
              type="button"
              className="agw-prov-model-wire-reset"
              onClick={() => updateModel(model.id, { providerType: undefined })}
            >
              Reset to {OPENCODE_WIRES.find((w) => w.value === ocDefault)?.label}
            </button>
          )}
        </div>
      )}

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
          {/* Temperature is a property of the MODEL, not of the app: one key
              addresses a model that wants 0.2 and another that rejects the
              parameter outright. Empty inherits — the provider's default, then
              Aurora's 0.8 — so an untouched install behaves as it always did.
              Claude 5 and newer reject sampling, and so does any model while
              reasoning is on; the Rust adapter drops the field there, which is
              why this says "ignored" rather than pretending to be universal. */}
          <label className="agw-prov-edit-field">
            <span>Temperature</span>
            <AgwTextInput
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={model.temperature ?? ""}
              // Empty means the field is not sent at all, so the provider's own
              // default applies. Saying "inherit · 0.8" implied Aurora had a
              // number in mind, which it no longer does — and which was
              // overriding providers that document their own.
              placeholder={
                typeof providerTemperature === "number"
                  ? `inherit · ${providerTemperature}`
                  : "provider default"
              }
              title="Leave empty to let the provider choose. 0 is deterministic, 1 is the usual API default. Ignored by models that reject sampling (Claude 5 and newer) and whenever reasoning is on."
              onChange={(e) =>
                updateModel(model.id, {
                  temperature: e.target.value === "" ? undefined : Number(e.target.value),
                })
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
          {/* Both cache rates fall back to the input price rather than to zero,
            * and the placeholder says so — a blank price field that silently
            * meant "free" is what made cached conversations under-report their
            * cost. Cached input is usually a large discount (often ~10% of
            * base); cache writes are usually at or slightly above base. */}
          <label className="agw-prov-edit-field">
            <span>Cached input · per 1M</span>
            <AgwTextInput
              type="number"
              value={model.priceCacheHitPerMtok ?? ""}
              placeholder="= input price"
              onChange={(e) =>
                updateModel(model.id, {
                  priceCacheHitPerMtok: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label className="agw-prov-edit-field">
            <span>Cache write · per 1M</span>
            <AgwTextInput
              type="number"
              value={model.priceCacheWritePerMtok ?? ""}
              placeholder="= input price"
              onChange={(e) =>
                updateModel(model.id, {
                  priceCacheWritePerMtok: e.target.value ? Number(e.target.value) : undefined,
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
                // Only the controls models.dev says this model HAS. Offering
                // `budget` on a model that has no budget control isn't a
                // harmless extra choice: the number gets dropped on the wire
                // and the user is given no sign the setting does nothing.
                // A row with no `supported` list predates the field — offer
                // everything there rather than hiding a control already in use.
                options={(
                  [
                    { value: "none", label: "None" },
                    { value: "toggle", label: "On/off" },
                    { value: "effort", label: "Effort" },
                    { value: "budget", label: "Budget" },
                  ] as const
                ).filter(
                  (o) =>
                    o.value === "none" ||
                    !reasoning?.supported?.length ||
                    reasoning.supported.includes(o.value) ||
                    // Never hide the option that is currently selected, or the
                    // control would vanish mid-edit and strand the value.
                    reasoning.type === o.value,
                )}
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
  const cursor = isCursorProvider(provider);
  const opencode = isOpenCodeProvider(provider);
  const builtIn = isBuiltInProvider(provider);
  const kenari = isKenariProvider(provider);
  const wire = kenariWire(provider);

  // Only a provider the user added can be deleted. The ones Aurora ships with
  // are theirs to configure, not to remove — so the destructive control simply
  // is not there for them, rather than being present and refusing. Two-click
  // confirm on the ones that can go, so it isn't a one-tap loss.
  const doRemove = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    removeProvider(provider.id);
    onDeleted();
  };

  return (
    <div className="agw-prov-detail" data-atlas={atlas || undefined}>
      {/* ── Who this provider is, and how to reach it ──────────────────────
          Everything above the models: identity, plan usage, endpoint, keys.
          Its own region so it stays put while the model list below scrolls —
          the pane as a whole never scrolls, which is what made the provider's
          own name disappear off the top while you were reading its models. */}
      <div className="agw-prov-detail-top agw-scroll">
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
      ) : cursor ? (
        <CursorProviderCard
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : opencode ? (
        <OpenCodeProviderCard
          apiKey={provider.apiKey}
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
          onKeyImported={(apiKey) => updateProvider(provider.id, { apiKey })}
        />
      ) : kenari ? (
        /* kenari owns its head for the same reason the four above do: the plan
           bar is the first thing worth reading, and the generic name/type head
           would push it below the fold. The connection fields and the model
           list still render underneath — unlike Codex, kenari has a real key
           and real models to edit. */
        <KenariUsageCard
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : (
        <div className="agw-prov-detail-head">
          <ProviderAvatar provider={provider} />
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

      {/* Connection. Codex and Cursor have none to edit — endpoint and auth
          are managed by the card above, and both Rust adapters pin the URL so
          a stale field could not reroute a turn anyway. Cursor also owns its
          own model list, which the generic model editor must not duplicate. */}
      {!codex && !cursor && (
      <div className="agw-prov-conn">
        {/* kenari answers the same account on three different wires, and the
            choice changes real behaviour — not a preference. Offered here
            rather than buried in Extra request fields, with what each one
            costs you written underneath, because the two non-default options
            both give something up. */}
        {kenari && (
          <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>API format</span>
            <AgwSegmented<KenariWire>
              ariaLabel="kenari API format"
              value={wire}
              options={KENARI_WIRES.map((w) => ({ value: w.value, label: w.label }))}
              onChange={(next) => updateProvider(provider.id, { providerType: next })}
            />
            <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
              {KENARI_WIRES.find((w) => w.value === wire)?.detail}
            </span>
          </label>
        )}
        {/* OpenCode Go has no row-level format picker, unlike kenari above.
            kenari's three wires all serve the same account, so choosing one is
            a real preference. Here the wire belongs to the model — each id
            accepts exactly one and answers 500 or a misleading 401 on the
            others — so the control lives on each model row instead. */}
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
                // The icon names the ACTION, not the current state: while the
                // key is visible the button hides it, so it wears the struck
                // eye. aria-pressed is what tells a screen reader which way
                // the toggle currently sits.
                aria-label={showKey ? "Hide API key" : "Show API key"}
                aria-pressed={showKey}
                title={showKey ? "Hide API key" : "Show API key"}
              >
                <AgentIcon name={showKey ? "eye-off" : "eye"} size={14} />
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
      </div>

      {/* ── Models ─────────────────────────────────────────────────────────
          The region that scrolls. Its heading and the add-a-model row are
          pinned to it, so the list can be long without the controls that act
          on it sliding away.

          Cursor is the exception: its list is the ACCOUNT's, pulled on connect
          and replaced on refresh, and the card above is the only place it can
          be curated. Rendering the generic editor here too would offer an
          "add a model" box whose rows a refresh silently discards, under a
          "Models 0" heading that contradicts the list already on screen. */}
      {!cursor && (
        <div className="agw-prov-detail-models">
          {/* Heading outside the panel, the way the skills catalog names its
              own — so the panel below is one object holding one list. */}
          <div className="agw-prov-models-head">
            Models <span className="agw-prov-models-count">{models.length}</span>
          </div>
          <p className="agw-prov-models-hint">
            New models auto-fill from models.dev — context window, limits, capabilities, pricing, and
            reasoning levels. Everything is overridable.
          </p>
          {/* Said once, above the list, rather than on all 29 rows. Every row
              carries the control; only a row that differs from its default
              carries anything else. Repeating one sentence down a list teaches
              nobody anything and buries the rows that genuinely differ. */}
          {opencode && (
            <p className="agw-prov-models-hint">
              Each model answers on one API format, already set per model. Change a Format only
              when that model starts failing. The wrong one returns a server error, or a 401 that
              looks like a rejected key.
            </p>
          )}
          <div className="agw-prov-models-panel">
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
                    providerTemperature={provider.defaultTemperature}
                  />
                ))
              )}
            </div>
            <AddModelRow providerId={provider.id} providerType={provider.providerType} />
          </div>
        </div>
      )}

      {/* Delete, for providers the user added. Two-click confirm; the second
          click commits. A built-in gets a line saying why there is nothing to
          click here — a missing control with no explanation reads as a bug. */}
      {cursor ? (
        <div className="agw-prov-detail-note">
          Comes with Aurora. Your plan decides which models exist — switch on the
          ones you want and they appear in the model picker.
        </div>
      ) : builtIn ? (
        <div className="agw-prov-detail-note">
          Comes with Aurora. Change its address, key and models freely — the provider
          itself stays in the list.
        </div>
      ) : (
        <div className="agw-prov-detail-danger">
          <button
            type="button"
            className="agw-prov-remove-btn"
            data-confirm={confirmRemove || undefined}
            onClick={doRemove}
            onMouseLeave={() => setConfirmRemove(false)}
            title="Delete provider"
          >
            <AgentIcon name="close" size={13} />
            {confirmRemove ? "Click again to delete" : "Delete provider"}
          </button>
        </div>
      )}
    </div>
  );
};

// ── Sidebar row ──────────────────────────────────────────────────────────────

// forwardRef because the groups' AnimatePresence runs mode="popLayout", which
// measures the outgoing row through a ref before popping it out of the layout
// — a plain function component here warns and breaks the exit measurement.
const ProviderRow = React.forwardRef<
  HTMLDivElement,
  {
    provider: LLMProvider;
    modelCount: number;
    active: boolean;
    onSelect: () => void;
    pinned: boolean;
    onTogglePin: () => void;
  }
>(function ProviderRow({ provider, modelCount, active, onSelect, pinned, onTogglePin }, ref) {
  const ready = providerReady(provider);
  const name = provider.nickname || provider.name;
  return (
    // A container, not a button — the open control is a stretched button
    // behind the content so the pin button can sit above it (a button cannot
    // contain a button; same shape as the skill card).
    //
    // motion + `layout`: pinning removes this row from one group and mounts
    // it in another, and without an animation that reads as a teleport. The
    // groups' AnimatePresence (mode="popLayout") fades the old instance out
    // while siblings glide closed, and this fades the new one in.
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="agw-prov-item"
      data-active={active || undefined}
    >
      <button
        type="button"
        className="agw-prov-item-hit"
        aria-label={`Open ${name}`}
        aria-current={active || undefined}
        onClick={onSelect}
      />
      <ProviderAvatar provider={provider} small />
      <span className="agw-prov-item-text">
        <span className="agw-prov-item-name">{name}</span>
        <span className="agw-prov-item-sub">
          {modelCount} {modelCount === 1 ? "model" : "models"}
        </span>
      </span>
      <button
        type="button"
        className="agw-prov-pin"
        data-on={pinned || undefined}
        title={pinned ? "Unpin provider" : "Pin provider"}
        aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
        aria-pressed={pinned}
        onClick={onTogglePin}
      >
        <AgentIcon name="pin" size={12} />
      </button>
      <span
        className="agw-prov-status-dot"
        data-tone={ready ? "ready" : "off"}
        title={ready ? "Ready" : "Needs API key"}
      />
    </motion.div>
  );
});

// ── Page (master–detail) ─────────────────────────────────────────────────────

export const ProvidersSettings: React.FC = () => {
  const providers = useSettingsStore((s) => s.providers);
  const models = useSettingsStore((s) => s.models);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const addCustomProvider = useSettingsStore((s) => s.addCustomProvider);
  const updateModel = useSettingsStore((s) => s.updateModel);

  const [activeId, setActiveId] = useState<string | null>(null);

  // Each rail group is a disclosure, same pattern as the left rail's Projects
  // header: chevron + click to collapse. Persisted, so the sidebar reopens
  // the way it was left instead of springing everything open on every visit.
  const [groupsOpen, setGroupsOpen] = useState<ProviderGroupsOpen>(loadProviderGroupsOpen);
  const toggleGroup = (key: keyof ProviderGroupsOpen) => {
    setGroupsOpen((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveProviderGroupsOpen(next);
      return next;
    });
  };

  // Pinned providers float into their own group at the top, from either list —
  // the left rail's pinned-projects pattern, persisted the same way.
  const [pinnedIds, setPinnedIds] = useState<string[]>(loadPinnedProviders);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const toggleProviderPin = (id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      savePinnedProviders(next);
      return next;
    });
  };

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
        // Fill ONLY genuinely-empty fields; `reasoning` is never touched —
        // that one is the user's to configure, and models.dev must not
        // restore it after they clear it.
        //
        // Capabilities ARE filled, by OR. models.dev publishes vision, tool
        // calling and reasoning support for every model it knows, and this
        // pass was throwing all three away — so a seeded model kept the
        // `false` that preset seeding wrote as a placeholder, and the user
        // had to switch vision and tool-streaming on by hand, per model,
        // before the provider they had just added could take a screenshot.
        // OR rather than assignment so this can only ever turn a capability
        // ON: whatever the user has enabled survives untouched. The one thing
        // it can undo is a capability switched OFF on a model seeded this
        // session and not yet backfilled — a narrow window, since the model
        // stops qualifying (`contextWindow` becomes non-null) the first time
        // this runs.
        updateModel(m.id, {
          contextWindow: m.contextWindow ?? e.contextWindow,
          maxOutputTokens: m.maxOutputTokens ?? e.maxOutputTokens,
          supportsVision: m.supportsVision || e.supportsVision,
          supportsThinking: m.supportsThinking || e.supportsThinking,
          supportsToolStream: m.supportsToolStream || e.supportsToolStream,
          priceCacheHitPerMtok: m.priceCacheHitPerMtok ?? e.priceCacheHitPerMtok,
          priceCacheMissPerMtok: m.priceCacheMissPerMtok ?? e.priceCacheMissPerMtok,
          priceOutputPerMtok: m.priceOutputPerMtok ?? e.priceOutputPerMtok,
          priceCacheWritePerMtok: m.priceCacheWritePerMtok ?? e.priceCacheWritePerMtok,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [models, updateModel]);

  // Shipped-with-Aurora rows first, then the user's own. Sorting is stable, so
  // providers the user added stay in the order they added them.
  const { builtIn, custom } = useMemo(() => groupProviders(providers), [providers]);

  // A pinned provider lives ONLY in the Pinned group (like a pinned chat in
  // the rail) — leaving it in its home group too would draw one provider as
  // two rows that highlight together.
  const pinnedProviders = useMemo(
    () => [...builtIn, ...custom].filter((p) => pinnedSet.has(p.id)),
    [builtIn, custom, pinnedSet],
  );
  const builtInRest = useMemo(
    () => builtIn.filter((p) => !pinnedSet.has(p.id)),
    [builtIn, pinnedSet],
  );
  const customRest = useMemo(
    () => custom.filter((p) => !pinnedSet.has(p.id)),
    [custom, pinnedSet],
  );

  // Keep a valid selection as the provider list changes. The fallback follows
  // the order the rail DRAWS, not the order the store happens to hold — picking
  // `providers[0]` would highlight a row further down the list on first open.
  const selected =
    providers.find((p) => p.id === activeId) ??
    pinnedProviders[0] ??
    builtInRest[0] ??
    customRest[0] ??
    null;
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
        {/* Two groups, because the two kinds of row behave differently: the
            ones Aurora ships with can be configured but not removed, the ones
            below are the user's own. Grouping is carried by a label and a
            hairline rather than by boxing each group — the rail already has
            enough edges. */}
        {providers.length === 0 ? (
          <div className="agw-prov-empty">No providers yet.</div>
        ) : (
          // One LayoutGroup across all three groups, so when a pin moves a row
          // the siblings in BOTH lists glide instead of snapping.
          <LayoutGroup>
            {/* Pinned area. The user's pins and the shipped providers are the
                short, fixed sets people return to — scrolling them away to
                reach a long custom list is the wrong trade. Only the list that
                grows without bound scrolls. */}
            {(pinnedProviders.length > 0 || builtInRest.length > 0) && (
              <div className="agw-prov-side-pinned">
                {pinnedProviders.length > 0 && (
                  <div className="agw-prov-group">
                    <button
                      type="button"
                      className="agw-prov-group-label"
                      aria-expanded={groupsOpen.pinned}
                      onClick={() => toggleGroup("pinned")}
                      title={
                        groupsOpen.pinned
                          ? "Collapse pinned providers"
                          : "Expand pinned providers"
                      }
                    >
                      <span className="agw-prov-group-name">
                        <AgentIcon
                          name="chevron-down"
                          size={11}
                          className="agw-prov-group-caret"
                          style={{
                            transform: groupsOpen.pinned ? undefined : "rotate(-90deg)",
                          }}
                        />
                        Pinned
                      </span>
                      <span className="agw-prov-group-count">
                        {pinnedProviders.length}
                      </span>
                    </button>
                    <Collapse open={groupsOpen.pinned}>
                      <AnimatePresence initial={false} mode="popLayout">
                        {pinnedProviders.map((p) => (
                          <ProviderRow
                            key={p.id}
                            provider={p}
                            modelCount={modelsByProvider.get(p.id)?.length ?? 0}
                            active={p.id === selected?.id}
                            onSelect={() => setActiveId(p.id)}
                            pinned
                            onTogglePin={() => toggleProviderPin(p.id)}
                          />
                        ))}
                      </AnimatePresence>
                    </Collapse>
                  </div>
                )}
                {builtInRest.length > 0 && (
                  <div className="agw-prov-group">
                    <button
                      type="button"
                      className="agw-prov-group-label"
                      aria-expanded={groupsOpen.builtIn}
                      onClick={() => toggleGroup("builtIn")}
                      title={
                        groupsOpen.builtIn
                          ? "Collapse built-in providers"
                          : "Expand built-in providers"
                      }
                    >
                      <span className="agw-prov-group-name">
                        <AgentIcon
                          name="chevron-down"
                          size={11}
                          className="agw-prov-group-caret"
                          style={{
                            transform: groupsOpen.builtIn ? undefined : "rotate(-90deg)",
                          }}
                        />
                        Built-in
                      </span>
                      <span className="agw-prov-group-count">
                        {builtInRest.length}
                      </span>
                    </button>
                    <Collapse open={groupsOpen.builtIn}>
                      <AnimatePresence initial={false} mode="popLayout">
                        {builtInRest.map((p) => (
                          <ProviderRow
                            key={p.id}
                            provider={p}
                            modelCount={modelsByProvider.get(p.id)?.length ?? 0}
                            active={p.id === selected?.id}
                            onSelect={() => setActiveId(p.id)}
                            pinned={false}
                            onTogglePin={() => toggleProviderPin(p.id)}
                          />
                        ))}
                      </AnimatePresence>
                    </Collapse>
                  </div>
                )}
              </div>
            )}
            <div className="agw-prov-side-scroll agw-scroll">
              <div className="agw-prov-group" data-divided={builtIn.length > 0 || undefined}>
                <button
                  type="button"
                  className="agw-prov-group-label"
                  aria-expanded={groupsOpen.custom}
                  onClick={() => toggleGroup("custom")}
                  title={
                    groupsOpen.custom
                      ? "Collapse custom providers"
                      : "Expand custom providers"
                  }
                >
                  <span className="agw-prov-group-name">
                    <AgentIcon
                      name="chevron-down"
                      size={11}
                      className="agw-prov-group-caret"
                      style={{
                        transform: groupsOpen.custom ? undefined : "rotate(-90deg)",
                      }}
                    />
                    Custom
                  </span>
                  {customRest.length > 0 && (
                    <span className="agw-prov-group-count">{customRest.length}</span>
                  )}
                </button>
                <Collapse open={groupsOpen.custom}>
                  <AnimatePresence initial={false} mode="popLayout">
                    {customRest.map((p) => (
                      <ProviderRow
                        key={p.id}
                        provider={p}
                        modelCount={modelsByProvider.get(p.id)?.length ?? 0}
                        active={p.id === selected?.id}
                        onSelect={() => setActiveId(p.id)}
                        pinned={false}
                        onTogglePin={() => toggleProviderPin(p.id)}
                      />
                    ))}
                  </AnimatePresence>
                  {custom.length === 0 && (
                    <p className="agw-prov-group-empty">
                      Anything you add below lands here.
                    </p>
                  )}
                </Collapse>
              </div>
            </div>
          </LayoutGroup>
        )}
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
