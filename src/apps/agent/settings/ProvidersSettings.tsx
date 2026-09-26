/**
 * Agent Window — Settings · Providers & Models (view).
 *
 * agw-native. Reads/writes the SHARED `useAgentSettingsStore` (+ the v17 `reasoning`
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

import {
  CHAT_SHORTLIST_MAX,
  useAgentSettingsStore,
  type LLMModel,
  type LLMProvider,
} from "@/apps/agent/store/settings/useAgentSettingsStore";
import type {
  ReasoningReplayMode,
  ReasoningRequestMode,
} from "@/kernel/types/database";
import { lookupModel, type ModelsDevEntry } from "@/apps/agent/services/providers/models-dev";
import { isAtlasCloudProvider } from "@/apps/agent/services/providers/atlascloud";
import { isCodexProvider } from "@/apps/agent/services/providers/codex";
import { isClaudeCodeProvider } from "@/apps/agent/services/providers/claude-code";
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
import { ImageProviderCard } from "@/apps/agent/settings/ImageProvidersSection";
import {
  imageProviderReady,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";
import {
  loadCollapsedCategories,
  loadPinnedProviders,
  loadProviderGroupsOpen,
  loadProviderSelection,
  saveCollapsedCategories,
  savePinnedProviders,
  saveProviderGroupsOpen,
  saveProviderSelection,
  type ProviderGroupsOpen,
} from "./provider-pins";
import {
  NewCategoryRow,
  ProviderCategoryHeader,
} from "./ProviderCategoryHeader";
import {
  BUILT_IN_CATEGORY_ID,
  categoryOf,
  sectionsFor,
} from "@/apps/agent/services/providers/provider-categories";
import {
  isKenariProvider,
  kenariWire,
  KENARI_WIRES,
  type KenariWire,
} from "@/apps/agent/services/providers/kenari";
import {
  isAgentRouterProvider,
  agentRouterWire,
  AGENT_ROUTER_WIRES,
  type AgentRouterWire,
} from "@/apps/agent/services/providers/presets/agentrouter";
import { isModalProvider } from "@/apps/agent/services/providers/modal";
import { isMinimaxProvider } from "@/apps/agent/services/providers/minimax";
import {
  deepseekBaseUrlForWire,
  deepseekWire,
  isDeepSeekProvider,
  DEEPSEEK_WIRES,
  type DeepSeekWire,
} from "@/apps/agent/services/providers/deepseek";
import {
  arkBaseUrlForWire,
  arkWire,
  ARK_WIRES,
  isArkProvider,
  type ArkWire,
} from "@/apps/agent/services/providers/ark";
import { ModalWorkspaceCard } from "./ModalWorkspaceCard";
import { ProviderAvatar } from "./ProviderAvatar";
import { ProviderDescription } from "./ProviderDescription";
import { AgentIcon } from "../shared/AgentIcon";
import { ModelTestButton } from "./ModelTestButton";
import { AtlasCloudUsageCard } from "./AtlasCloudUsageCard";
import { CodexUsageCard } from "./CodexUsageCard";
import { ClaudeCodeProviderCard } from "./ClaudeCodeProviderCard";
import { KenariUsageCard } from "./KenariUsageCard";
import { ArkUsageCard } from "./ArkUsageCard";
import { MinimaxUsageCard } from "./MinimaxUsageCard";
import { DeepSeekProviderCard } from "./DeepSeekProviderCard";
import { CursorProviderCard } from "./CursorProviderCard";
import { OpenCodeProviderCard } from "./OpenCodeProviderCard";
import { CommandCodeProviderCard } from "./CommandCodeProviderCard";
import { isCommandCodeProvider } from "@/apps/agent/services/providers/commandcode";
import {
  AgwButton,
  AgwPill,
  AgwSegmented,
  AgwSelect,
  AgwSwitch,
  AgwTextInput,
} from "./primitives";
import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";

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

type EditableApiFormat = "inherit" | "chat" | "responses" | "messages";

/** One set of words for the three formats — the picker, the row chip and the
 *  provider-level note all read from here so they can never drift apart. */
const API_FORMAT_LABEL: Record<Exclude<EditableApiFormat, "inherit">, string> = {
  chat: "Chat",
  responses: "Responses",
  messages: "Messages",
};

/**
 * Providers that speak exactly ONE wire, where a per-model format override is
 * not a choice but a way to break the row.
 *
 * The picker exists for an account that genuinely serves several shapes — a
 * gateway where one model wants Chat and another wants Responses. On these it
 * offers three options of which two are wrong: Codex and Cursor pin their URL
 * in Rust, and MiniMax's address ends in `/anthropic/v1`, so anything but
 * Messages sends the wrong body to a path that does not exist.
 *
 * DeepSeek is here for a third reason. It genuinely serves all three shapes,
 * but the choice belongs to the ROW: its Messages wire sits on a different
 * path (`/anthropic`), and the row-level picker rewrites the URL to match.
 * A per-model override would change the body without moving the address, so
 * two of its three options would post the wrong shape to a 404 — and since
 * both DeepSeek models accept every wire, a per-model choice buys nothing
 * anyway.
 *
 * OpenCode Go is excluded separately at the call site rather than added here.
 * Its wire genuinely belongs to the model — each id accepts exactly one and
 * answers 500 on the others — so the picker is hidden for a different reason:
 * `applyOpenCodeWire` has already made the choice per model.
 */
const PINNED_WIRE_TYPES = new Set([
  "codex",
  "claude-code",
  "cursor",
  "minimax",
  "deepseek",
  "deepseek-messages",
  "deepseek-responses",
]);

function hasPinnedWire(providerType: string | undefined): boolean {
  return PINNED_WIRE_TYPES.has((providerType ?? "").toLowerCase());
}

function apiFormatForProviderType(type: string | undefined): Exclude<EditableApiFormat, "inherit"> {
  const normalized = (type ?? "").toLowerCase();
  if (
    [
      "anthropic",
      "claude-code",
      "minimax",
      "kenari-messages",
      "opencode-go-messages",
      "modal-messages",
      "deepseek-messages",
    ].includes(normalized)
  ) {
    return "messages";
  }
  if (
    [
      "openai-responses",
      "kenari-responses",
      "opencode-go",
      "codex",
      "modal-responses",
      "deepseek-responses",
    ].includes(normalized)
  ) {
    return "responses";
  }
  return "chat";
}

/** Preserve a gateway's named dialect when changing only its wire format. */
function providerTypeForApiFormat(
  providerType: string | undefined,
  format: Exclude<EditableApiFormat, "inherit">,
): string {
  const owner = (providerType ?? "custom").toLowerCase();
  if (owner.startsWith("kenari")) {
    return format === "responses"
      ? "kenari-responses"
      : format === "messages"
        ? "kenari-messages"
        : "kenari";
  }
  if (owner.startsWith("modal")) {
    return format === "responses"
      ? "modal-responses"
      : format === "messages"
        ? "modal-messages"
        : "modal";
  }
  if (owner.startsWith("opencode-go")) {
    return format === "responses"
      ? "opencode-go"
      : format === "messages"
        ? "opencode-go-messages"
        : "opencode-go-chat";
  }
  if (format === "responses") return "openai-responses";
  if (format === "messages") return "anthropic";
  // Dedicated Chat adapters keep their vendor behavior when Chat is chosen.
  return apiFormatForProviderType(owner) === "chat" ? owner : "openai";
}

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

// ── Comma-separated list input ───────────────────────────────────────────────

/**
 * A text input for a comma-separated list whose PARSED value lives in the
 * store. The naive version — `value={items.join(", ")}` re-rendered on every
 * keystroke — made separators untypable: the parser trims and drops empty
 * segments, so the `,` or space you just typed was parsed away and the render
 * snapped the text back without it. Only pasting a complete string worked.
 *
 * While focused, the field shows exactly what was typed (the draft); every
 * keystroke still parses into the store so the rest of the UI stays live.
 * On blur the draft is dropped and the field snaps to the normalized
 * `join(", ")` form.
 */
const AgwListInput: React.FC<{
  items: string[];
  placeholder?: string;
  onItems: (items: string[]) => void;
}> = ({ items, placeholder, onItems }) => {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <AgwTextInput
      value={draft ?? items.join(", ")}
      placeholder={placeholder}
      onFocus={() => setDraft(items.join(", "))}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        onItems(
          e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
};

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
  // `reasoning_replay` has a dedicated control (the Thinking-replay selector
  // above); it is hidden here and preserved on save so the two never fight
  // over one key.
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(model.extraBody ?? {})
      .filter(([k]) => k !== "reasoning_replay")
      .map(([k, val]) => ({
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
    const replay = model.extraBody?.["reasoning_replay"];
    if (replay !== undefined) {
      obj["reasoning_replay"] = replay;
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

// ── Get models: ask the provider what it has, pick from the answer ───────────

/** Mirrors Rust `commands::provider_models::DiscoveredModel` (serde camelCase). */
interface DiscoveredModel {
  id: string;
  displayName: string | null;
}

/**
 * "Get models" — the provider's own list, instead of typing ids from memory.
 *
 * Nearly every provider publishes `GET <base>/models`, and until now only the
 * rows with a bespoke importer (Modal, Command Code, OpenCode, kenari, the
 * local runtimes) used it. An ordinary API-key row was the one kind still
 * asking a person to know the ids by heart.
 *
 * Three decisions worth keeping:
 *
 * 1. **It appears only once the row can actually ask.** A key is what the
 *    request needs, so before there is one the button could only ever fail —
 *    and a control that is present but always fails teaches people to distrust
 *    the ones that work. A row that needs no key (local runtimes,
 *    `requiresApiKey: false`) shows it immediately, because those can ask.
 * 2. **It lists, it does not add.** A gateway can answer with three hundred
 *    models and nobody wants three hundred rows because they pressed a button
 *    once. What comes back is a list to choose from; adding is still a
 *    deliberate act, and each added model goes through the SAME models.dev
 *    enrichment as one typed by hand — `/models` carries no context window and
 *    no pricing, and inventing those from an id is how a limit ends up wrong
 *    in a way nobody notices until a turn is rejected.
 * 3. **Models already on the row are shown as already there, not hidden.**
 *    Hiding them makes the list disagree with the one below it, and the
 *    question people actually have — "did I already add this one" — is exactly
 *    what the marker answers.
 */
const FetchModelsRow: React.FC<{
  providerId: string;
  baseUrl: string;
  apiKey: string;
  providerType?: string;
  existing: Set<string>;
}> = ({ providerId, baseUrl, apiKey, providerType, existing }) => {
  const addModel = useAgentSettingsStore((s) => s.addModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveredModel[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const fetchModels = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const models = await invoke<DiscoveredModel[]>("provider_list_models", {
        baseUrl,
        apiKey,
        providerType,
      });
      setFound(models);
      setPicked(new Set());
    } catch (e) {
      // Rust already phrased this for a person to act on; showing it verbatim
      // is the point. Re-wording it here would lose which of the four failures
      // it was.
      setError(typeof e === "string" ? e : String(e));
      setFound(null);
    } finally {
      setBusy(false);
    }
  };

  const addPicked = async () => {
    if (adding || picked.size === 0) return;
    setAdding(true);
    try {
      // Sequential on purpose: `addModel` folds into one store record, and
      // firing them together races the writes against each other.
      for (const key of picked) {
        const entry = await lookupModel(key, providerType);
        if (entry) {
          // Same rule as the typed path: models.dev for METADATA only, and the
          // id stays exactly as the provider spelled it, because that string
          // is what goes on the wire.
          addModel(providerId, { ...entryToModelInit(entry), modelKey: key });
        } else {
          addModel(providerId, {
            modelKey: key,
            supportsVision: false,
            supportsThinking: false,
            supportsToolStream: true,
            enabled: true,
          });
        }
      }
      setFound(null);
      setPicked(new Set());
    } finally {
      setAdding(false);
    }
  };

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectable = (found ?? []).filter((m) => !existing.has(m.id));
  const allPicked = selectable.length > 0 && selectable.every((m) => picked.has(m.id));

  return (
    <div className="agw-prov-fetch">
      <div className="agw-prov-fetch-head">
        <AgwButton icon="download" onClick={() => void fetchModels()} disabled={busy}>
          {busy ? "Asking…" : "Get models"}
        </AgwButton>
        <span className="agw-prov-fetch-note">
          {error ??
            (found
              ? `${found.length} model${found.length === 1 ? "" : "s"} from this provider. Pick the ones you want.`
              : "Asks this provider for its model list, so you don't have to know the ids.")}
        </span>
      </div>

      {found && found.length > 0 && (
        <div className="agw-prov-fetch-panel">
          <div className="agw-prov-fetch-actions">
            <button
              type="button"
              className="agw-prov-fetch-all"
              onClick={() =>
                setPicked(allPicked ? new Set() : new Set(selectable.map((m) => m.id)))
              }
              disabled={selectable.length === 0}
            >
              {allPicked ? "Clear selection" : `Select all ${selectable.length}`}
            </button>
            <button
              type="button"
              className="agw-prov-fetch-close"
              onClick={() => {
                setFound(null);
                setPicked(new Set());
              }}
            >
              Close
            </button>
          </div>
          <div className="agw-prov-fetch-list agw-scroll">
            {found.map((m) => {
              const already = existing.has(m.id);
              return (
                <label key={m.id} className="agw-prov-fetch-item" data-added={already || undefined}>
                  <input
                    type="checkbox"
                    checked={already || picked.has(m.id)}
                    disabled={already}
                    onChange={() => toggle(m.id)}
                  />
                  <span className="agw-prov-fetch-id">{m.id}</span>
                  {m.displayName && (
                    <span className="agw-prov-fetch-label">{m.displayName}</span>
                  )}
                  {already && <span className="agw-prov-fetch-added">added</span>}
                </label>
              );
            })}
          </div>
          <AgwButton
            variant="primary"
            icon="plus"
            onClick={() => void addPicked()}
            disabled={adding || picked.size === 0}
          >
            {adding
              ? "Adding…"
              : picked.size === 0
                ? "Select models to add"
                : `Add ${picked.size} model${picked.size === 1 ? "" : "s"}`}
          </AgwButton>
        </div>
      )}
    </div>
  );
};

// ── Add-model row: type a model id → it auto-fills from models.dev ────────────

const AddModelRow: React.FC<{ providerId: string; providerType?: string }> = ({
  providerId,
  providerType,
}) => {
  const addModel = useAgentSettingsStore((s) => s.addModel);
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
  /** The provider's wire format — a model-level override wins over it. */
  providerType?: string;
}> = ({ model, active, onActivate, providerTemperature, providerType }) => {
  const updateModel = useAgentSettingsStore((s) => s.updateModel);
  const deleteModel = useAgentSettingsStore((s) => s.deleteModel);
  // Aurora Chat's shortlist. `selection` is the same `providerId:modelKey`
  // string the composer and the thread sidecar use, so a ticked row and a
  // pinned conversation are talking about the same thing.
  const selection = `${model.providerId}:${model.modelKey}`;
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";
  const shortlisted = useAgentSettingsStore((s) => s.chatModelShortlist.includes(selection));
  const shortlistFull = useAgentSettingsStore(
    (s) => s.chatModelShortlist.length >= CHAT_SHORTLIST_MAX,
  );
  const toggleChatShortlistModel = useAgentSettingsStore((s) => s.toggleChatShortlistModel);
  const [editing, setEditing] = useState(false);
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [limitsNote, setLimitsNote] = useState<string | null>(null);
  const reasoning = model.reasoning;
  const isOpenCode = model.providerId === OPENCODE_PROVIDER_ID;
  const ocDefault = defaultOpenCodeWire(model.modelKey);
  const ocWire = openCodeWireFor(model);
  const ctx = model.contextWindow ? formatContextWindow(model.contextWindow) : null;
  // Both numbers must be present to compare them; an unset field inherits and
  // is not a contradiction.
  const outputExceedsWindow =
    typeof model.contextWindow === "number" &&
    typeof model.maxOutputTokens === "number" &&
    model.maxOutputTokens >= model.contextWindow;
  const price =
    model.priceOutputPerMtok != null
      ? `$${model.priceCacheMissPerMtok ?? "?"} / $${model.priceOutputPerMtok}`
      : null;

  // Thinking replay applies only on the OpenAI-compatible wire. Anthropic,
  // Responses, Codex and Cursor replay thinking natively — showing the
  // control there would be a switch that does nothing.
  const effectiveWire = (isOpenCode ? ocWire : model.providerType ?? providerType ?? "").toLowerCase();
  const wireFormat: "chat" | "responses" | "messages" | "native" =
    [
      "anthropic",
      "claude-code",
      "minimax",
      "kenari-messages",
      "opencode-go-messages",
      "modal-messages",
      "deepseek-messages",
    ].includes(effectiveWire)
      ? "messages"
      : [
            "openai-responses",
            "kenari-responses",
            "opencode-go",
            "modal-responses",
            "deepseek-responses",
          ].includes(effectiveWire)
        ? "responses"
        : ["codex", "cursor"].includes(effectiveWire)
          ? "native"
          : "chat";
  const replayApplies = !!reasoning && wireFormat === "chat";
  // The provider card names one API type, and this row is allowed to disagree
  // with it — the model's own choice is what reaches the wire. A header that
  // silently does not apply is worse than no header, so the row states which
  // format it actually uses whenever it differs. Absent when the row inherits:
  // repeating the provider's own answer on every model is noise.
  // OpenCode already carries a visible Format control of its own further down.
  const providerApiFormat = apiFormatForProviderType(providerType);
  const modelApiFormat = model.providerType
    ? apiFormatForProviderType(model.providerType)
    : providerApiFormat;
  const apiFormatOverridden =
    !isOpenCode && !!model.providerType && modelApiFormat !== providerApiFormat;
  // New rows store replay beside the rest of the reasoning profile. Read the
  // old extra-body key as a migration fallback until the row is edited.
  const replayRaw = reasoning?.replay ?? model.extraBody?.["reasoning_replay"];
  const replayValue: ReasoningReplayMode =
    replayRaw === false
      ? "off"
      : typeof replayRaw === "string"
        ? replayRaw.toLowerCase() === "reasoning_content"
          ? "reasoning_content"
          : replayRaw.toLowerCase() === "reasoning"
            ? "reasoning"
            : ["off", "none", "drop", "false"].includes(replayRaw.toLowerCase())
              ? "off"
              : "auto"
        : "auto";
  const setReplay = (next: ReasoningReplayMode) => {
    if (!reasoning) return;
    const rest = { ...(model.extraBody ?? {}) };
    delete rest["reasoning_replay"];
    updateModel(model.id, {
      reasoning: {
        ...reasoning,
        replay: next === "auto" ? undefined : next,
      },
      extraBody: Object.keys(rest).length > 0 ? rest : undefined,
    });
  };
  const requestMode: ReasoningRequestMode = reasoning?.requestMode ?? "auto";
  const requestModeOptions: Array<{ value: ReasoningRequestMode; label: string }> =
    wireFormat === "messages"
      ? [
          { value: "auto", label: "Auto" },
          { value: "anthropic-adaptive", label: "Adaptive" },
          { value: "anthropic-budget", label: "Token budget" },
        ]
      : wireFormat === "chat"
        ? [
            { value: "auto", label: "Auto" },
            { value: "openai-effort", label: "Effort field" },
            { value: "openai-thinking", label: "Thinking object" },
          ]
        : [];

  // Either wire override moved off Auto. Drives both the "Overridden" pill and
  // the disclosure's initial state: a setting someone changed has to still be
  // findable, so it opens itself rather than hiding behind a closed row.
  const wireOverridden = requestMode !== "auto" || replayValue !== "auto";
  const [wireOpen, setWireOpen] = useState(wireOverridden);
  const [pricingOpen, setPricingOpen] = useState(false);

  return (
    <div className="agw-prov-model" data-active={active || undefined}>
      <div className="agw-prov-model-top">
        <button type="button" className="agw-prov-model-main" onClick={onActivate} title="Use this model">
          <span className="agw-prov-model-radio" data-on={active || undefined} />
          <span className="agw-prov-model-name">{model.label || model.modelKey}</span>
          {active && <AgwPill tone="success">Active</AgwPill>}
        </button>
        <div className="agw-prov-model-actions">
          {/* Aurora Chat's shortlist. Present only on that side: Build's roster
              is long on purpose and has no shortlist, so the control would be a
              switch with nothing behind it. */}
          {chatSurface && (
            <button
              type="button"
              role="switch"
              aria-checked={shortlisted}
              className="agw-prov-chat-pick"
              data-on={shortlisted || undefined}
              disabled={!shortlisted && shortlistFull}
              title={
                shortlisted
                  ? "Offered in Aurora Chat's model picker. Click to remove."
                  : shortlistFull
                    ? `Aurora Chat holds ${CHAT_SHORTLIST_MAX} models. Remove one to add this.`
                    : "Offer this model in Aurora Chat's model picker"
              }
              onClick={() => toggleChatShortlistModel(selection)}
            >
              <AgentIcon name={shortlisted ? "check" : "plus"} size={12} />
              <span>Chat</span>
            </button>
          )}
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
        {apiFormatOverridden && (
          <span
            className="agw-prov-chip"
            data-tone="override"
            title={`This model uses the ${API_FORMAT_LABEL[modelApiFormat]} format instead of the provider's ${API_FORMAT_LABEL[providerApiFormat]}.`}
          >
            {API_FORMAT_LABEL[modelApiFormat]} format
          </span>
        )}
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
          {!isOpenCode && !hasPinnedWire(providerType) && (
            <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
              <span>API format</span>
              <AgwSegmented<EditableApiFormat>
                ariaLabel={`API format for ${model.label || model.modelKey}`}
                value={model.providerType ? apiFormatForProviderType(model.providerType) : "inherit"}
                options={[
                  { value: "inherit", label: "Provider default" },
                  { value: "chat", label: API_FORMAT_LABEL.chat },
                  { value: "responses", label: API_FORMAT_LABEL.responses },
                  { value: "messages", label: API_FORMAT_LABEL.messages },
                ]}
                onChange={(next) =>
                  updateModel(model.id, {
                    providerType:
                      next === "inherit"
                        ? undefined
                        : providerTypeForApiFormat(providerType, next),
                  })
                }
              />
              <span className="agw-set-row-hint">
                Overrides this model only. Use it when one account serves different models on different endpoints, or when one format returns text but drops reasoning.
              </span>
            </div>
          )}
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
          {/* An output cap at or above the context window is impossible: the
              prompt and the reply are drawn from the same window. Providers
              reject it outright, before a token is generated, so every turn on
              the model fails — and the number is invisible unless you open this
              panel. Real: a catalogue entry published output = context =
              1,048,560 for glm-5.2, which no endpoint serving it accepts.
              Warn where the number lives, and offer the repair rather than
              leaving the user to find the right one. */}
          {outputExceedsWindow && (
            <div className="agw-prov-field-note" role="status">
              <AgentIcon name="alert" size={13} />
              <span>
                Max output is larger than the context window. They share one budget, so this
                model's requests are rejected before they run.{" "}
                <button
                  type="button"
                  className="agw-prov-field-note-btn"
                  disabled={limitsBusy}
                  onClick={async () => {
                    setLimitsBusy(true);
                    setLimitsNote(null);
                    try {
                      const entry = await lookupModel(model.modelKey, providerType);
                      if (entry?.maxOutputTokens) {
                        updateModel(model.id, {
                          contextWindow: entry.contextWindow ?? model.contextWindow,
                          maxOutputTokens: entry.maxOutputTokens,
                        });
                      } else {
                        setLimitsNote(
                          "No published limit for this model — set Max output by hand (128,000 is a safe start).",
                        );
                      }
                    } finally {
                      setLimitsBusy(false);
                    }
                  }}
                >
                  {limitsBusy ? "Checking…" : "Use published limits"}
                </button>
              </span>
            </div>
          )}
          {limitsNote && <div className="agw-prov-field-note">{limitsNote}</div>}
          {/* Temperature is a property of the MODEL, not of the app: one key
              addresses a model that wants 0.2 and another that rejects the
              parameter outright. Empty inherits the provider's default, or
              omits the field when that is also empty.
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
          {/* Four rates, filled from models.dev on add and edited about once in
              a model's life — but they used to occupy half the open card, every
              time it opened, next to the fields people actually come here for.
              Behind a row that already answers the question most people have
              ("is a price set at all?"), so opening it is for changing one. */}
          <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <button
              type="button"
              className="agw-prov-wire-toggle"
              aria-expanded={pricingOpen}
              onClick={() => setPricingOpen((v) => !v)}
            >
              <AgentIcon name="chevron-down" size={12} />
              <span>Pricing</span>
              <AgwPill tone="neutral">
                {price ? `${price} per 1M` : "not set"}
              </AgwPill>
            </button>
          </div>

          {pricingOpen && (
            <>
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
              {/* Both cache rates fall back to the input price rather than to
                * zero, and the placeholder says so — a blank price field that
                * silently meant "free" is what made cached conversations
                * under-report their cost. Cached input is usually a large
                * discount (often ~10% of base); cache writes are usually at or
                * slightly above base. */}
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
            </>
          )}
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
                    // "Toggle", not "On/off": the row below asks whether a
                    // level-based model can be switched OFF, and two controls
                    // two rows apart both saying "off" meant neither could be
                    // read without the other. This one names the KIND of
                    // control (and matches the stored `toggle` value); that one
                    // names a property of the model.
                    { value: "toggle", label: "Toggle" },
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
                    return updateModel(model.id, {
                      reasoning: {
                        type: "toggle",
                        default: true,
                        requestMode: reasoning?.requestMode,
                        replay: reasoning?.replay,
                      },
                      supportsThinking: true,
                    });
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
                      reasoning: {
                        type: "effort",
                        levels,
                        default: carried,
                        requestMode: reasoning?.requestMode,
                        replay: reasoning?.replay,
                      },
                      supportsThinking: true,
                    });
                  }
                  return updateModel(model.id, {
                    reasoning: {
                      type: "budget",
                      min: reasoning?.min ?? 1024,
                      max: reasoning?.max ?? 32000,
                      default: typeof reasoning?.default === "number" ? reasoning.default : 8000,
                      requestMode: reasoning?.requestMode,
                      replay: reasoning?.replay,
                    },
                    supportsThinking: true,
                  });
                }}
              />
            </span>

            {reasoning?.type === "effort" && (
              <label className="agw-prov-edit-field">
                <span>Levels (comma-separated)</span>
                <AgwListInput
                  items={reasoning.levels ?? []}
                  placeholder="low, medium, high"
                  onItems={(levels) => {
                    const def =
                      levels.includes(String(reasoning.default)) ? reasoning.default : levels[levels.length - 1];
                    updateModel(model.id, { reasoning: { ...reasoning, levels, default: def } });
                  }}
                />
              </label>
            )}

            {/* Asks one thing — can this model stop reasoning? — and shows the
                answer as a switch. It used to be a captioned button whose label
                restated its own caption ("Reasoning on/off" over "Always on
                (native)"), which read as a SECOND reasoning-type picker sitting
                directly under the first. */}
            {/* States a property of the MODEL — it always reasons — rather than
                asking about a control, so it shares no vocabulary with the
                reasoning-kind row above. Shown inverted against the stored
                `toggleable` for the same reason: "can be switched off" put the
                word "off" beside a "Toggle" option and neither row could be
                read on its own. */}
            {reasoning?.type === "effort" && (
              <div className="agw-prov-edit-field agw-prov-reason-toggle">
                <span>Always reasons</span>
                <AgwSwitch
                  ariaLabel="This model always reasons and cannot be stopped"
                  checked={reasoning.toggleable === false}
                  onChange={(alwaysReasons) =>
                    updateModel(model.id, {
                      reasoning: { ...reasoning, toggleable: !alwaysReasons },
                    })
                  }
                />
                <span className="agw-set-row-hint">
                  On for a model that cannot stop reasoning. The composer then shows only the
                  level, with no switch beside it.
                </span>
              </div>
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

          {/* The two wire-shape overrides, behind a disclosure.
              They are not more reasoning settings — they describe how this
              GATEWAY wants the reasoning fields spelled, and Auto is right for
              every provider that behaves. Left expanded they put two more
              "Reasoning …" captions and four paragraphs of prose directly under
              the reasoning configurator, so the panel read as five competing
              copies of one setting.
              Open when either is set, so an override is never hidden from the
              person who has to find it again. */}
          {(reasoning && requestModeOptions.length > 0) || replayApplies ? (
            <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                className="agw-prov-wire-toggle"
                aria-expanded={wireOpen}
                onClick={() => setWireOpen((v) => !v)}
              >
                <AgentIcon name="chevron-down" size={12} />
                <span>Gateway wire format</span>
                {wireOverridden && <AgwPill tone="neutral">Overridden</AgwPill>}
              </button>
              <span className="agw-set-row-hint">
                How this endpoint spells the reasoning fields. Auto is correct unless the
                gateway documents otherwise.
              </span>
            </div>
          ) : null}

          {wireOpen && reasoning && requestModeOptions.length > 0 && (
            <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
              <span>Reasoning request</span>
              <AgwSegmented<ReasoningRequestMode>
                ariaLabel="Reasoning request format"
                value={requestMode}
                options={requestModeOptions}
                onChange={(next) =>
                  updateModel(model.id, {
                    reasoning: {
                      ...reasoning,
                      requestMode: next === "auto" ? undefined : next,
                    },
                  })
                }
              />
              <span className="agw-set-row-hint">
                {wireFormat === "messages"
                  ? "How this gateway is asked for reasoning depth. Adaptive for newer Messages APIs, Token budget for older ones."
                  : "How this gateway is asked for reasoning depth. Change it only if it documents a different shape."}
              </span>
            </div>
          )}

          {/* What happens to the model's earlier thinking on the next request.
              Auto = the measured policy (send only when this endpoint demands
              it in a 400). The explicit Send options exist for gateways that
              quietly accept the field — no signal can detect those, so only
              the person who knows their gateway can flip it. */}
          {/* A <div>, NOT a <label>: a click anywhere inside a label — the
              caption, the hint, the whitespace — is forwarded by the browser
              to its first form control, which here is the segmented group's
              first button. Wrapped in a label, clicking the hint text reset
              the control to its first option. Same reason the Reasoning
              configurator above uses a span. */}
          {wireOpen && replayApplies && (
            <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
              <span>Thinking replay</span>
              <AgwSegmented
                ariaLabel="Thinking replay"
                value={replayValue}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "reasoning_content", label: "reasoning_content" },
                  { value: "reasoning", label: "reasoning" },
                  { value: "off", label: "Off" },
                ]}
                onChange={(v) => setReplay(v as ReasoningReplayMode)}
              />
              <span className="agw-set-row-hint">
                Which field carries the model's earlier thinking back to this provider. Auto
                matches the provider's own; a gateway that refuses or requires the field
                overrides this.
              </span>
            </div>
          )}

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
  /** Move the rail's selection — a card that creates a sibling row uses it. */
  onSelectProvider?: (id: string) => void;
}> = ({ provider, models, selectedModel, onDeleted, onSelectProvider }) => {
  const updateProvider = useAgentSettingsStore((s) => s.updateProvider);
  const removeProvider = useAgentSettingsStore((s) => s.removeProvider);
  const setSelectedModel = useAgentSettingsStore((s) => s.setSelectedModel);
  // Read here rather than passed down: the detail pane is the one place a
  // provider is moved BETWEEN categories, and threading two more props through
  // for it would make every caller of this component carry them.
  const providerCategories = useAgentSettingsStore((s) => s.providerCategories);
  const setProviderCategory = useAgentSettingsStore((s) => s.setProviderCategory);
  const [showKey, setShowKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const atlas = isAtlasCloudProvider(provider);
  const codex = isCodexProvider(provider);
  const claudeCode = isClaudeCodeProvider(provider);
  const cursor = isCursorProvider(provider);
  const opencode = isOpenCodeProvider(provider);
  const commandcode = isCommandCodeProvider(provider);
  const builtIn = isBuiltInProvider(provider);
  const kenari = isKenariProvider(provider);
  const ark = isArkProvider(provider);
  const modal = isModalProvider(provider);
  // Providers whose address the vendor fixes. The key is the only thing almost
  // anyone sets, so the endpoint moves under a disclosure instead of sitting
  // above the field they opened the card for. Still editable — a proxy or a
  // self-hosted deployment is a real thing — just not the first thing offered.
  //
  // A boolean rather than a special case in the markup, so switching another
  // provider to this shape later is one name on this line.
  const minimax = isMinimaxProvider(provider);
  const pinnedEndpoint = minimax;
  const deepseek = isDeepSeekProvider(provider);
  const deepseekWireValue = deepseekWire(provider);
  const wire = kenariWire(provider);
  const arkWireValue = arkWire(provider);
  const agentrouter = isAgentRouterProvider(provider);
  const arWire = agentRouterWire(provider);
  // How many model rows below have set their own API format. The control here
  // reads as the answer for the whole provider, and for those rows it is not —
  // so it says so, next to itself, rather than letting someone read a request
  // shape off this card that a model row has already changed.
  const modelsWithOwnApiFormat = models.filter(
    (m) =>
      m.providerType &&
      apiFormatForProviderType(m.providerType) !==
        apiFormatForProviderType(provider.providerType),
  ).length;

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
      ) : claudeCode ? (
        /* Same shape as Codex: the card owns sign-in and the plan meters, and
           there is no key or endpoint to edit — Rust pins both. The seeded
           model list still renders underneath. */
        <ClaudeCodeProviderCard
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
      ) : commandcode ? (
        /* Owns its head for the same reason the ones above do: which account
           is paying is the first thing worth reading, and it has two possible
           answers. The key field and the model list still render underneath. */
        <CommandCodeProviderCard
          apiKey={provider.apiKey}
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
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
      ) : ark ? (
        /* Same shape as kenari's, and for the same reason: the quota bars are
           the first thing worth reading, and this is the other provider where a
           working key cannot read its own account — Volcano's control plane
           refuses the `ark-` key, so the numbers come from a console sign-in. */
        <ArkUsageCard
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : minimax ? (
        /* Same reason as kenari's: the plan bars are the first thing worth
           reading and the generic head would push them below the fold. Unlike
           kenari's, this card needs the KEY — on MiniMax the subscription key
           is also the account credential, so there is no sign-in to run and the
           card fills in the moment a key is pasted below. */
        <MinimaxUsageCard
          apiKey={provider.apiKey}
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : deepseek ? (
        /* Same reason as MiniMax's — the account figure is the first thing
           worth reading and the generic head would push it below the fold —
           but what it draws is a BALANCE, not a plan. DeepSeek bills per
           token, so there is no window to meter and no reset to count down
           to. It needs the key and the base URL: the key reads the account,
           and the URL says which account, since the wire picker below rewrites
           it and a proxied row is a different account entirely. */
        <DeepSeekProviderCard
          apiKey={provider.apiKey}
          baseUrl={provider.baseUrl}
          enabled={provider.enabled}
          onToggleEnabled={(v) => updateProvider(provider.id, { enabled: v })}
        />
      ) : modal ? (
        /* Modal's card owns the whole connection — region, token, endpoint
           list and wire — because on Modal they are one decision, so the
           generic fields below are skipped for it the way Codex's are. */
        <ModalWorkspaceCard provider={provider} models={models} onSelectProvider={onSelectProvider} />
      ) : (
        <div className="agw-prov-detail-head">
          <ProviderAvatar provider={provider} />
          <div className="agw-prov-detail-titles">
            <div className="agw-prov-detail-name">{provider.nickname || provider.name}</div>
            <div className="agw-prov-detail-sub">{provider.providerType ?? "custom"}</div>
            <ProviderDescription
              providerName={provider.nickname || provider.name}
              value={provider.description}
              onChange={(description) => updateProvider(provider.id, { description })}
            />
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
      {!codex && !claudeCode && !cursor && !modal && (
      <div className="agw-prov-conn">
        {/* Where this provider sits in the rail. First field, because it is
            identity rather than connection: it is the same kind of fact as the
            name, and it decides which section you will look in to find this
            row again.

            This is the move-an-existing-provider path. Adding a new one goes
            the other way round — you pick the category first, from the rail —
            so the two never disagree about which is the source of truth. */}
        <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
          <span>Category</span>
          <AgwSelect
            ariaLabel={`Category for ${provider.name}`}
            value={categoryOf(providerCategories, provider)}
            options={providerCategories.categories.map((c) => ({
              value: c.id,
              label: c.name,
            }))}
            onChange={(next) => setProviderCategory(provider.id, next)}
          />
        </label>
        {/* kenari answers the same account on three different wires, and the
            choice changes real behaviour — not a preference. Offered here
            rather than buried in Extra request fields, with what each one
            costs you written underneath, because the two non-default options
            both give something up. */}
        {/* <div> wrappers, not <label>: a click anywhere inside a label lands
            on its first form control — here the segmented group's first
            button — so clicking the detail line silently flipped the picker
            back to its first option. */}
        {kenari && (
          <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
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
          </div>
        )}
        {/* Ark answers the same account on three wires, kenari-style — but
            with one difference that matters: its wires are on DIFFERENT PATHS,
            not different suffixes of one base URL. Messages is
            `/api/coding/v1`, chat and responses are `/api/coding/v3`. So this
            writes the URL as well as the type; changing only the type would
            leave the row pointed at a path that 404s. */}
        {ark && (
          <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>API format</span>
            <AgwSegmented<ArkWire>
              ariaLabel="Volcano Ark API format"
              value={arkWireValue}
              options={ARK_WIRES.map((w) => ({ value: w.value, label: w.label }))}
              onChange={(next) =>
                updateProvider(provider.id, {
                  providerType: next,
                  baseUrl: arkBaseUrlForWire(next),
                })
              }
            />
            <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
              {ARK_WIRES.find((w) => w.value === arkWireValue)?.detail}
            </span>
          </div>
        )}
        {/* DeepSeek answers the same account on three wires, and here the
            choice is not a preference at all — each one drops something the
            others have. Chat is the only one with strict tool schemas and the
            only one that REFUSES a tool loop when the chain-of-thought is not
            replayed. Messages returns signed thinking, so reasoning survives a
            tool loop the way it does on Anthropic. Responses returns thinking
            as plain text with no signature.

            Writes the URL as well as the type, Ark-style: Messages lives on a
            different PATH (`/anthropic`), so changing only the type would
            leave the row pointed at something that 404s. */}
        {deepseek && (
          <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>API format</span>
            <AgwSegmented<DeepSeekWire>
              ariaLabel="DeepSeek API format"
              value={deepseekWireValue}
              options={DEEPSEEK_WIRES.map((w) => ({ value: w.value, label: w.label }))}
              onChange={(next) =>
                updateProvider(provider.id, {
                  providerType: next,
                  baseUrl: deepseekBaseUrlForWire(next),
                })
              }
            />
            <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
              {DEEPSEEK_WIRES.find((w) => w.value === deepseekWireValue)?.detail}
            </span>
          </div>
        )}
        {/* AgentRouter answers the same account on two wires, kenari-style.
            Both are standard shapes, so the choice is just the provider type.
            No Responses option: /v1/responses is a 404 and the root path only
            serves the dashboard page (probed live 2026-08-27). */}
        {agentrouter && (
          <div className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>API format</span>
            <AgwSegmented<AgentRouterWire>
              ariaLabel="AgentRouter API format"
              value={arWire}
              options={AGENT_ROUTER_WIRES.map((w) => ({ value: w.value, label: w.label }))}
              onChange={(next) => updateProvider(provider.id, { providerType: next })}
            />
            <span style={{ fontSize: "var(--agw-fs-micro)", color: "var(--agw-text-subtle)" }}>
              {AGENT_ROUTER_WIRES.find((w) => w.value === arWire)?.detail}
            </span>
          </div>
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
            <div className="agw-prov-edit-field">
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
              {modelsWithOwnApiFormat > 0 && (
                <span className="agw-set-row-hint">
                  {modelsWithOwnApiFormat === 1
                    ? "1 model below sets its own format and ignores this."
                    : `${modelsWithOwnApiFormat} models below set their own format and ignore this.`}
                </span>
              )}
            </div>
          </>
        )}
        {/* Above the key for a provider whose address is genuinely a choice.
            For one the vendor pins, it moves below and into a disclosure —
            see `pinnedEndpoint` and the <details> after the key field. */}
        {!pinnedEndpoint && (
          <label className="agw-prov-edit-field" style={{ gridColumn: "1 / -1" }}>
            <span>Base URL</span>
            <AgwTextInput
              value={provider.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
            />
          </label>
        )}
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
        {/* The pinned endpoint, folded away.
          *
          * Native <details> rather than a state hook: it is a disclosure, the
          * element exists for exactly this, and it arrives keyboard-operable
          * and correctly announced without anything to wire up.
          *
          * Closed by default and it says what is behind it while closed. A
          * disclosure whose summary reads "Advanced" makes you open it to find
          * out whether you needed it; this one names the address, so the answer
          * to "is it pointing at the right place" is already on screen. */}
        {pinnedEndpoint && (
          <details className="agw-prov-endpoint" style={{ gridColumn: "1 / -1" }}>
            <summary className="agw-prov-endpoint-summary">
              <AgentIcon name="chevron-down" size={12} className="agw-prov-endpoint-chev" />
              <span>Endpoint</span>
              <span className="agw-prov-endpoint-url">{provider.baseUrl}</span>
            </summary>
            <label className="agw-prov-edit-field agw-prov-endpoint-body">
              <span>Base URL</span>
              <AgwTextInput
                value={provider.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
              />
              <span className="agw-set-row-hint">
                Set by the provider. Change it only to reach a proxy or a self-hosted
                deployment.
              </span>
            </label>
          </details>
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
          {modal && (
            <p className="agw-prov-models-hint">
              These rows are the workspace's live endpoints, named by their hostname. Refresh
              endpoints above after deploying or stopping one; a row added by hand needs the
              endpoint's full hostname as its model id.
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
                    providerType={provider.providerType}
                  />
                ))
              )}
            </div>
            {/* Only once the row can actually ask — see `FetchModelsRow`. A
                provider that needs no key (a local runtime, or a preset with
                `requiresApiKey: false`) can ask from the start. */}
            {(hasAnyKey(provider) || provider.requiresApiKey === false) && (
              <FetchModelsRow
                providerId={provider.id}
                baseUrl={provider.baseUrl}
                apiKey={provider.apiKey}
                providerType={provider.providerType}
                existing={new Set(models.map((m) => m.modelKey))}
              />
            )}
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

/**
 * A picture-making provider in the rail.
 *
 * The same row as a language provider, minus the pin — pinning exists to lift
 * one row out of a list of forty, and this group holds a handful. It lives in
 * the rail because that is where you choose a provider; the fields belonged in
 * the detail pane all along, and putting them under the SELECTED provider's
 * settings instead meant every provider's page ended with somebody else's.
 */
const ImageProviderRailRow: React.FC<{
  provider: ImageProvider;
  active: boolean;
  onSelect: () => void;
}> = ({ provider, active, onSelect }) => {
  const ready = imageProviderReady(provider);
  const count = provider.models.length;
  return (
    <motion.div
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
        aria-label={`Open ${provider.name}`}
        aria-current={active || undefined}
        onClick={onSelect}
      />
      <span className="agw-prov-avatar agw-prov-avatar-sm">
        <AgentIcon name="image" size={13} />
      </span>
      <span className="agw-prov-item-text">
        <span className="agw-prov-item-name">{provider.name}</span>
        <span className="agw-prov-item-sub">
          {count} {count === 1 ? "model" : "models"}
        </span>
      </span>
      <span
        className="agw-prov-status-dot"
        data-tone={ready ? "ready" : "off"}
        title={ready ? "Ready" : "Needs an address and a key"}
      />
    </motion.div>
  );
};

// ── Page (master–detail) ─────────────────────────────────────────────────────

export const ProvidersSettings: React.FC = () => {
  const providers = useAgentSettingsStore((s) => s.providers);
  const models = useAgentSettingsStore((s) => s.models);
  const selectedModel = useAgentSettingsStore((s) => s.selectedModel);
  const addCustomProvider = useAgentSettingsStore((s) => s.addCustomProvider);
  const addImageProvider = useAgentSettingsStore((s) => s.addImageProvider);
  const imageProviders = useAgentSettingsStore((s) => s.imageProviders);
  const updateModel = useAgentSettingsStore((s) => s.updateModel);

  // Seeded from the last visit, not null: leaving settings unmounts this whole
  // page, so a fresh `null` would drop you back on the first row every time.
  const [activeId, setActiveId] = useState<string | null>(
    () => loadProviderSelection().providerId,
  );

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

  // ── Categories ─────────────────────────────────────────────────────────
  //
  // The categories themselves come from the store (they are account facts and
  // will group the model selector too). What is local to this rail is which
  // ones are folded, and which one new providers land in.
  const providerCategories = useAgentSettingsStore((s) => s.providerCategories);
  const createProviderCategory = useAgentSettingsStore((s) => s.createProviderCategory);
  const renameProviderCategory = useAgentSettingsStore((s) => s.renameProviderCategory);
  const setProviderCategoryColor = useAgentSettingsStore((s) => s.setProviderCategoryColor);
  const deleteProviderCategory = useAgentSettingsStore((s) => s.deleteProviderCategory);
  const moveProviderCategory = useAgentSettingsStore((s) => s.moveProviderCategory);
  const setProviderCategory = useAgentSettingsStore((s) => s.setProviderCategory);

  const [collapsedCats, setCollapsedCats] = useState<string[]>(loadCollapsedCategories);
  const collapsedSet = useMemo(() => new Set(collapsedCats), [collapsedCats]);
  const toggleCategoryOpen = (id: string) => {
    setCollapsedCats((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveCollapsedCategories(next);
      return next;
    });
  };
  /**
   * Open a category, whatever state it was in.
   *
   * Separate from the toggle above, and not written in terms of it, because a
   * toggle is only safe when nothing else in the same click also folds. That
   * exact pair — the heading toggling and a second handler "expanding if
   * collapsed" — cancelled out and made expanding impossible: the second
   * handler read the fold state from the render it was called in, which the
   * first had already changed. An idempotent open cannot do that.
   */
  const expandCategory = (id: string) => {
    setCollapsedCats((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((x) => x !== id);
      saveCollapsedCategories(next);
      return next;
    });
  };

  /**
   * Which category the footer's Add provider will fill.
   *
   * A provider has to live somewhere, so there is no such thing as adding one
   * without answering this. Null means nothing is targeted yet, and the footer
   * says so rather than offering a button that would have to guess.
   */
  const [targetCategoryId, setTargetCategoryId] = useState<string | null>(null);
  // Derived, never synced: a targeted category that is then deleted resolves
  // to null here and the footer falls back to its hint on the same render. An
  // effect clearing the id would be a second source of truth for the same
  // fact, and it would also throw the target away if the category came back.
  const targetCategory =
    providerCategories.categories.find((c) => c.id === targetCategoryId) ?? null;

  /**
   * Target a category, and nothing else.
   *
   * It must not touch the fold: the heading's own click already toggles that,
   * and a second opinion about it in the same click is what broke expanding.
   * Opening on demand belongs to the paths that need a row to be VISIBLE —
   * `addProviderTo` — not to targeting.
   */
  const selectCategory = (id: string) => setTargetCategoryId(id);

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

  /** Image providers are an Aurora Chat thing; Build makes software. */
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";

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
  // Everything not pinned, grouped into the categories the user made, then
  // the two seeds holding whatever is unfiled. `sectionsFor` is the single
  // source of that order and guarantees each provider appears exactly once —
  // see `services/providers/provider-categories.ts`.
  //
  // Built-in order is preserved INSIDE each section by feeding it the already
  // sorted list, so a category holding shipped rows still lists them in the
  // catalogue's order rather than in map-insertion order.
  const unpinned = useMemo(
    () => [...builtIn, ...custom].filter((p) => !pinnedSet.has(p.id)),
    [builtIn, custom, pinnedSet],
  );
  const sections = useMemo(
    () => sectionsFor(providerCategories, unpinned),
    [providerCategories, unpinned],
  );
  const userSections = useMemo(() => sections.filter((s) => !s.category.system), [sections]);
  const systemSections = useMemo(() => sections.filter((s) => s.category.system), [sections]);

  // Keep a valid selection as the provider list changes. The fallback follows
  // the order the rail DRAWS, not the order the store happens to hold — picking
  // `providers[0]` would highlight a row further down the list on first open.
  const selected =
    providers.find((p) => p.id === activeId) ??
    pinnedProviders[0] ??
    sections.flatMap((s) => s.providers)[0] ??
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

  // Which IMAGE provider the detail pane is showing, kept apart from `activeId`
  // so the language-provider fallback above cannot fight it. Non-null wins the
  // pane; picking any language row clears it.
  const [activeImageId, setActiveImageId] = useState<string | null>(
    () => loadProviderSelection().imageProviderId,
  );
  const activeImage = imageProviders.find((p) => p.id === activeImageId) ?? null;
  const selectProvider = (id: string) => {
    setActiveImageId(null);
    setActiveId(id);
  };

  // Remember what the pane was showing, after the fallback above has resolved
  // it, so the next visit reopens on the same row. A stored image id whose row
  // has since been deleted is cleared rather than left pointing at nothing —
  // otherwise the rail highlights a row that is not there and the pane quietly
  // shows a language provider instead.
  useEffect(() => {
    if (activeImageId && !activeImage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- drop a selection whose row is gone
      setActiveImageId(null);
      return;
    }
    saveProviderSelection({
      providerId: selected?.id ?? null,
      imageProviderId: activeImage?.id ?? null,
    });
  }, [selected, activeImage, activeImageId]);

  /**
   * Add a provider INTO a category.
   *
   * The category is required, not defaulted. A provider that lands nowhere is
   * the state this page was reorganised to remove, and picking a category on
   * the caller's behalf would put rows in a section they did not choose and
   * then hide that fact.
   */
  const addProviderTo = (categoryId: string) => {
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
    // A new row is always custom, so filing it under Custom is the same state
    // as not filing it; the store's transform handles that and stores nothing.
    setProviderCategory(id, categoryId);
    setTargetCategoryId(categoryId);
    // Open it, or the row that was just created lands inside a folded section
    // and the click looks like it did nothing. Idempotent, so it cannot fight
    // whatever else the same click touched.
    expandCategory(categoryId);
    setActiveId(id);
  };

  const addImage = () => {
    setActiveImageId(
      addImageProvider({
        name: "New image provider",
        baseUrl: "",
        apiFormat: "openai-images",
        enabled: true,
      }),
    );
  };

  return (
    <div className="agw-prov-page">
      {/* Provider sidebar — full height, flush with the content edge. */}
      <aside className="agw-prov-side">
        <div className="agw-prov-side-head">
          <span>Providers</span>
          <span className="agw-prov-side-count">{providers.length}</span>
        </div>
        {/* Categories, in the order the user arranged them, then the two seeds
            holding whatever is unfiled. Grouping is carried by a label and a
            hairline rather than by boxing each group — the rail already has
            enough edges.

            Pinned stays above all of it and is not a category: a pin is "right
            now", a category is "what kind of thing this is", and collapsing
            the two would lose the one that is cheap to change. */}
        {/* No `providers.length === 0` special case, deliberately. It used to
            replace this whole list with "No providers yet", which is now a dead
            end: adding a provider requires a category, and the only way to make
            one is the row at the bottom of this list. An empty rail must still
            offer the first move. The empty message lives in the detail pane,
            which is where there is room to say what to do about it. */}
        {
          // One LayoutGroup across every group, so when a pin or a move takes a
          // row out of one section the siblings in both glide instead of
          // snapping.
          <LayoutGroup>
            {pinnedProviders.length > 0 && (
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
                            onSelect={() => selectProvider(p.id)}
                            pinned
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
              {/* Your categories, then the two seeds. `sectionsFor` keeps an
                  empty category you just made — there has to be somewhere to
                  put the first provider — and drops an empty seed, because
                  those are leftovers rather than destinations. */}
              {[...userSections, ...systemSections].map(
                ({ category, providers: rows }, index) => (
                  <div
                    key={category.id}
                    className="agw-prov-group"
                    data-divided={
                      // One hairline where your categories end and the shipped
                      // split begins, not between every section.
                      (category.system && index === userSections.length) || undefined
                    }
                  >
                    <ProviderCategoryHeader
                      category={category}
                      count={rows.length}
                      open={!collapsedSet.has(category.id)}
                      selected={category.id === targetCategoryId}
                      onToggle={() => toggleCategoryOpen(category.id)}
                      onSelect={() => selectCategory(category.id)}
                      // Built-in cannot receive a new provider: its rows are
                      // Aurora's own, re-seeded on every launch.
                      canAddProviders={category.id !== BUILT_IN_CATEGORY_ID}
                      onAddProvider={() => addProviderTo(category.id)}
                      onRename={(name) => renameProviderCategory(category.id, name)}
                      onRecolor={(color) => setProviderCategoryColor(category.id, color)}
                      onMove={(direction) => moveProviderCategory(category.id, direction)}
                      onDelete={() => deleteProviderCategory(category.id)}
                      canMoveUp={!category.system && index > 0}
                      canMoveDown={!category.system && index < userSections.length - 1}
                    />
                    <Collapse open={!collapsedSet.has(category.id)}>
                      <AnimatePresence initial={false} mode="popLayout">
                        {rows.map((p) => (
                          <ProviderRow
                            key={p.id}
                            provider={p}
                            modelCount={modelsByProvider.get(p.id)?.length ?? 0}
                            active={p.id === selected?.id}
                            onSelect={() => selectProvider(p.id)}
                            pinned={false}
                            onTogglePin={() => toggleProviderPin(p.id)}
                          />
                        ))}
                      </AnimatePresence>
                      {rows.length === 0 && (
                        <p className="agw-prov-group-empty">
                          Empty. Use the plus on this heading to add a provider here, or
                          move one in from its own page.
                        </p>
                      )}
                    </Collapse>
                  </div>
                ),
              )}

              {/* Picture-making providers. Their own group in the rail, tagged
                  CHAT because that is the only side they work on — they used to
                  hang off the bottom of whichever provider happened to be
                  selected, which put an unrelated list under every one of them.
                  The plus adds one from here, where you are already looking. */}
              {chatSurface && (
                <div className="agw-prov-group" data-divided>
                  <button
                    type="button"
                    className="agw-prov-group-label"
                    aria-expanded={groupsOpen.images}
                    onClick={() => toggleGroup("images")}
                    title={
                      groupsOpen.images ? "Collapse image providers" : "Expand image providers"
                    }
                  >
                    <span className="agw-prov-group-name">
                      <AgentIcon
                        name="chevron-down"
                        size={11}
                        className="agw-prov-group-caret"
                        style={{
                          transform: groupsOpen.images ? undefined : "rotate(-90deg)",
                        }}
                      />
                      Image
                      <span className="agw-prov-group-tag">Chat</span>
                    </span>
                    {imageProviders.length > 0 && (
                      <span className="agw-prov-group-count">{imageProviders.length}</span>
                    )}
                    {/* A span, not a button: this sits inside the group's own
                        button and one cannot contain the other. Same trick the
                        provider row uses for its pin. */}
                    <span
                      role="button"
                      tabIndex={0}
                      className="agw-prov-group-add"
                      aria-label="Add an image provider"
                      title="Add an image provider"
                      onClick={(e) => {
                        e.stopPropagation();
                        addImage();
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        e.stopPropagation();
                        addImage();
                      }}
                    >
                      <AgentIcon name="plus" size={11} />
                    </span>
                  </button>
                  <Collapse open={groupsOpen.images}>
                    <AnimatePresence initial={false} mode="popLayout">
                      {imageProviders.map((p) => (
                        <ImageProviderRailRow
                          key={p.id}
                          provider={p}
                          active={p.id === activeImageId}
                          onSelect={() => setActiveImageId(p.id)}
                        />
                      ))}
                    </AnimatePresence>
                    {imageProviders.length === 0 && (
                      <p className="agw-prov-group-empty">
                        Somewhere to make pictures from a chat. Add the service you have a
                        key for.
                      </p>
                    )}
                  </Collapse>
                </div>
              )}
            </div>
          </LayoutGroup>
        }
        {/* The footer follows the rail rather than leading it. A provider has to
            land in a category, so with nothing targeted this cannot offer a
            button — it says which click makes one appear instead of rendering
            an Add provider that would have to guess where the row goes. */}
        <div className="agw-prov-list-foot">
          {/* Add provider is offered only once a category can receive one.
              Built-in cannot, so picking it leaves just New category here
              rather than a button that would file a hand-made row under
              Aurora's own heading. */}
          {targetCategory && targetCategory.id !== BUILT_IN_CATEGORY_ID && (
            <AgwButton
              variant="primary"
              icon="plus"
              onClick={() => addProviderTo(targetCategory.id)}
            >
              Add provider to {targetCategory.name}
            </AgwButton>
          )}
          {/* Making a category is a footer action, not a row in the list. It
              was a dashed row at the bottom of the scroll area, which put a
              control in the middle of the content it creates and scrolled away
              exactly when a long list made it hardest to reach. */}
          <NewCategoryRow
            onCreate={(name) => {
              const id = createProviderCategory(name);
              // Targeted straight away: naming a category is almost always
              // the first half of "and put something in it".
              if (id) setTargetCategoryId(id);
              return id !== null;
            }}
          />
        </div>
      </aside>

      {/* Detail pane — the selected provider's connection + models. */}
      <section className="agw-prov-main agw-scroll">
        <div className="agw-prov-main-inner">
          {activeImage ? (
            // Same outer shell as a language provider's detail, so the two
            // panes stack their sections on the same rhythm.
            <div className="agw-prov-detail">
              <ImageProviderCard
                key={activeImage.id}
                provider={activeImage}
                initiallyOpen
                standalone
              />
            </div>
          ) : selected ? (
            <ProviderDetail
              key={selected.id}
              provider={selected}
              models={modelsByProvider.get(selected.id) ?? []}
              selectedModel={selectedModel}
              onDeleted={() => setActiveId(null)}
              onSelectProvider={selectProvider}
            />
          ) : (
            <div className="agw-prov-detail agw-prov-detail-empty">
              <AgentIcon name="providers" size={24} style={{ color: "var(--agw-text-subtle)" }} />
              <div>No providers yet.</div>
              {/* Names the first move rather than offering a button that cannot
                  say where the row would land. With a category targeted it is
                  the same button the footer shows. */}
              {targetCategory ? (
                <AgwButton
                  variant="primary"
                  icon="plus"
                  onClick={() => addProviderTo(targetCategory.id)}
                >
                  Add provider to {targetCategory.name}
                </AgwButton>
              ) : (
                <div style={{ color: "var(--agw-text-subtle)", fontSize: "var(--agw-fs-label)" }}>
                  Make a category in the list on the left, then add a provider to it.
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
