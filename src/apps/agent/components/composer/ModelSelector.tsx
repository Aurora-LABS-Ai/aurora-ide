/**
 * Agent Window — model selector [view].
 *
 * The agent window's OWN model picker. A compact trigger pill (model glyph +
 * model label + chevron) opens a popover laid out like a real picker:
 * header (title · sort · count) · search · flat rich rows · footer.
 *
 * Each row is self-contained ("all model config in one place"): the model glyph,
 * name, provider, capability badges (Vision / Tools) and — merged in from the old
 * standalone reasoning pill — an inline reasoning on/off switch plus a reasoning
 * chip. The chip's behaviour follows the model's reasoning TYPE: an effort model
 * cycles its tier in place, a budget model opens a token-budget panel (slider +
 * presets + the share of the model's output cap). Both use the same pill so rows
 * keep one height. A tiny header **sort** button cycles the list order (recently
 * added / recently used / A–Z); the choice + per-model usage recency persist in
 * localStorage so the picker remembers how you like it.
 *
 * Styling is entirely `--agw-*` (one source of truth) with bespoke `AgentIcon`
 * glyphs — no hardcoded colors.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { reasoningIsOn, useSettingsStore, type LLMModel } from "@/kernel/store/useSettingsStore";
import {
  formatModelDisplayName,
  formatProviderNickname,
} from "@/kernel/lib/llm/provider-display";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { groupProviders } from "@/apps/agent/services/providers/built-in";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  normalizeThreadModelSelection,
  pinnedThreadModel,
} from "@/apps/agent/lib/thread/thread-model";
import {
  bumpUsage,
  rankByUsage,
  readModelUsage,
  writeModelUsage,
  type ModelUsage,
} from "@/apps/agent/lib/model/model-usage";
import {
  readFastPreferences,
  setFastOn,
  type FastPreferences,
} from "@/apps/agent/lib/model/cursor-fast";
import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";
import {
  cursorFastAvailable,
  resolveCursorFast,
} from "@/apps/agent/services/providers/cursor-run";

interface RichOption {
  providerId: string;
  providerName: string;
  model: string; // modelKey
  label: string;
  /** Matching `LLMModel.id` (present when the model lives in the models slice). */
  id?: string;
  vision: boolean;
  tools: boolean;
  reasoning?: LLMModel["reasoning"];
  /** Model's own output cap — the ceiling a thinking budget must stay under. */
  maxOutputTokens?: number;
  /** ms epoch for "recently added" sort (0 when unknown). */
  createdAt: number;
  sortOrder: number;
}

const MENU_EST_HEIGHT = 420;
/** How many models surface in the "Frequent" strip. */
const RECENT_MAX = 5;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ── Reasoning budget helpers ─────────────────────────────────────────────────

/** Anthropic's hard floor for `thinking.budget_tokens`, and the practical floor
 *  for every other backend that accepts a budget. */
const BUDGET_FLOOR = 1024;
const BUDGET_FALLBACK_CEILING = 32_000;
/** Panel box, used to place the portal before it has rendered/measured. */
const BUDGET_POP_WIDTH = 244;
const BUDGET_POP_HEIGHT = 176;

/** `16000` → `"16k"`, `1024` → `"1k"`. Compact enough for an 18px chip. */
const shortTokens = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k`.replace(".0k", "k") : String(n);

/** The usable `[min, max]` for a budget model, with sane fallbacks when the
 *  model row carries only a partial range (models.dev often omits one end).
 *
 *  The ceiling is the output cap MINUS ONE: a thinking budget must be strictly
 *  below `max_tokens` or the provider rejects the request, so "Max" has to be a
 *  value the user can actually send. */
function budgetRange(r: LLMModel["reasoning"], maxOutputTokens?: number): [number, number] {
  const min = Math.max(BUDGET_FLOOR, r?.min ?? BUDGET_FLOOR);
  const advertised = r?.max ?? maxOutputTokens ?? BUDGET_FALLBACK_CEILING;
  const capped = maxOutputTokens
    ? Math.min(advertised, maxOutputTokens - 1)
    : advertised;
  return [min, Math.max(min + 1, capped)];
}

/** Slider position (0–1000) ↔ token value, on a log scale.
 *
 *  Linear travel would spend the first 10% of the track on 1k–8k — where the
 *  meaningful choices actually live — and the remaining 90% on values nobody
 *  distinguishes. Log travel gives each doubling equal width. */
const posToTokens = (pos: number, min: number, max: number) => {
  const raw = Math.exp(Math.log(min) + (pos / 1000) * (Math.log(max) - Math.log(min)));
  const step = raw >= 8000 ? 1000 : 500;
  return Math.min(max, Math.max(min, Math.round(raw / step) * step));
};
const tokensToPos = (value: number, min: number, max: number) =>
  Math.round(
    ((Math.log(Math.min(max, Math.max(min, value))) - Math.log(min)) /
      (Math.log(max) - Math.log(min))) *
      1000,
  );

/** Preset stops offered under the slider, filtered to the model's own range.
 *  The top stop is always the model's maximum so "as much as it can" is one tap. */
function budgetPresets(min: number, max: number): { value: number; label: string }[] {
  const stops = [4000, 8000, 16000, 32000, 64000]
    .filter((v) => v > min && v < max)
    .slice(0, 3);
  return [
    { value: min, label: shortTokens(min) },
    ...stops.map((v) => ({ value: v, label: shortTokens(v) })),
    { value: max, label: "Max" },
  ];
}

/**
 * Budget picker for one model — the chip in the row plus its popover.
 *
 * The chip deliberately reuses `.agw-model-effort` so a budget model and an
 * effort model produce IDENTICAL row heights and shapes; only the popover is
 * new. Writes land on `reasoning.default` (the same field an effort model uses
 * for its tier), so persistence, reload, and the send path need no new storage.
 */
const RowBudget: React.FC<{
  modelId: string;
  reasoning: NonNullable<LLMModel["reasoning"]>;
  maxOutputTokens?: number;
  label: string;
}> = ({ modelId, reasoning, maxOutputTokens, label }) => {
  const updateModel = useSettingsStore((s) => s.updateModel);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Live position while the thumb is held. `updateModel` writes through to
  // SQLite on every call, and a range emits `change` on every step — so
  // committing per step meant a database round-trip per pixel dragged. The
  // draft keeps the control responsive; the store is written once, on release.
  const [draftPos, setDraftPos] = useState<number | null>(null);

  const [min, max] = budgetRange(reasoning, maxOutputTokens);
  const raw = typeof reasoning.default === "number" ? reasoning.default : min;
  const stored = Math.min(max, Math.max(min, raw));
  const value = draftPos === null ? stored : posToTokens(draftPos, min, max);
  const pos = draftPos ?? tokensToPos(stored, min, max);
  const presets = budgetPresets(min, max);

  // Dismiss on outside click / Escape, and follow the chip if the list scrolls
  // underneath it. The popover is PORTALED (see below), so "outside" has to
  // consider both the chip and the floating panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        chipRef.current?.focus();
      }
    };
    // A scroll or resize invalidates the measured anchor; close rather than
    // leave the panel stranded away from its chip.
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const commit = (next: number) => {
    setDraftPos(null);
    updateModel(modelId, {
      reasoning: { ...reasoning, enabled: true, default: Math.min(max, Math.max(min, next)) },
    });
  };

  /** End of a slider interaction: persist the dragged value, if any. */
  const settle = () => {
    if (draftPos !== null) commit(posToTokens(draftPos, min, max));
  };

  // The one genuinely broken state: an output cap too small to carry ANY valid
  // budget. The runtime then omits `thinking` entirely, so the model quietly
  // stops reasoning — worth saying out loud rather than letting it look fine.
  const capTooSmall = typeof maxOutputTokens === "number" && maxOutputTokens <= BUDGET_FLOOR;
  const share =
    typeof maxOutputTokens === "number" && maxOutputTokens > 0
      ? Math.round((value / maxOutputTokens) * 100)
      : null;

  /** Measure the chip and place the panel above it (the picker itself usually
   *  opens upward from the composer, so above keeps the panel on screen), then
   *  clamp both axes into the viewport. */
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(
        8,
        Math.min(rect.right - BUDGET_POP_WIDTH, window.innerWidth - BUDGET_POP_WIDTH - 8),
      );
      const above = rect.top - BUDGET_POP_HEIGHT - 6;
      const top = above >= 8 ? above : Math.min(rect.bottom + 6, window.innerHeight - BUDGET_POP_HEIGHT - 8);
      setAnchor({ left, top: Math.max(8, top) });
    }
    setOpen(true);
  };

  const portalTarget =
    (document.querySelector(".agw-root") as HTMLElement | null) ?? document.body;

  return (
    <span className="agw-model-reason-wrap" ref={wrapRef}>
      <button
        ref={chipRef}
        type="button"
        className="agw-model-effort"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Thinking budget — ${value.toLocaleString()} tokens`}
        onClick={toggle}
      >
        {shortTokens(value)}
      </button>
      {open && anchor && createPortal(
        <div
          ref={popRef}
          className="agw-bud-pop"
          // Portaling escapes `.agw-model-menu`'s `overflow: hidden` — but it
          // also escapes the menu's outside-click test, which is pure DOM
          // containment. Pressing the slider therefore read as a click outside
          // the picker and closed the whole menu, taking this panel with it:
          // the popover vanished the instant you tried to drag it. This marks
          // the node as logically inside its owner; dismiss handlers skip it.
          data-agw-portal-child=""
          role="dialog"
          aria-label={`Thinking budget for ${label}`}
          style={{ position: "fixed", left: anchor.left, top: anchor.top, width: BUDGET_POP_WIDTH }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="agw-bud-head">
            <span className="agw-bud-title">Thinking budget</span>
            <span className="agw-bud-value">{value.toLocaleString()}</span>
          </div>
          <input
            className="agw-bud-range"
            type="range"
            min={0}
            max={1000}
            step={1}
            value={pos}
            aria-label="Thinking budget in tokens"
            aria-valuetext={`${value.toLocaleString()} tokens`}
            style={{ ["--agw-bud-pct" as string]: `${pos / 10}%` }}
            onChange={(e) => setDraftPos(Number(e.target.value))}
            // Commit once the interaction ends, by whichever route it ends.
            // `blur` is the backstop: a pointer released outside the thumb or
            // a tab-away must not silently drop the value the user chose.
            onPointerUp={() => settle()}
            onKeyUp={() => settle()}
            onBlur={() => settle()}
          />
          <div className="agw-bud-scale">
            <span>{shortTokens(min)}</span>
            <span>{shortTokens(max)}</span>
          </div>
          <div className="agw-bud-presets">
            {presets.map((p) => (
              <button
                key={p.value}
                type="button"
                className="agw-bud-preset"
                data-on={value === p.value || undefined}
                onClick={() => commit(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="agw-bud-hint" data-tone={capTooSmall ? "warn" : undefined}>
            {capTooSmall
              ? `This model's ${maxOutputTokens!.toLocaleString()}-token output limit leaves no room to think. Raise Max output in provider settings.`
              : share !== null
                ? `${share}% of this model's ${shortTokens(maxOutputTokens!)} output limit. Higher budgets think longer and cost more.`
                : "Tokens the model may spend thinking before it answers. Higher budgets think longer and cost more."}
          </p>
        </div>,
        portalTarget,
      )}
    </span>
  );
};

// ── Per-row reasoning control (merged from the old ReasoningPicker) ───────────

const RowReasoning: React.FC<{
  opt: RichOption;
  fastOn: boolean;
  onFastUnavailable: () => void;
}> = ({ opt, fastOn, onFastUnavailable }) => {
  const updateModel = useSettingsStore((s) => s.updateModel);
  const r = opt.reasoning;
  if (!r || !opt.id) return null;

  const on = reasoningIsOn(r);
  const levels = r.levels ?? [];
  const hasEffort = r.type === "effort" && levels.length > 0;
  // Natively-reasoning models (`toggleable: false`) have no on/off — effort only.
  const showSwitch = r.toggleable !== false;
  const current = String(r.default ?? levels[levels.length - 1] ?? "");

  const commit = (next: NonNullable<LLMModel["reasoning"]>) => {
    if (
      opt.providerId === CURSOR_PROVIDER_ID &&
      fastOn &&
      !cursorFastAvailable({ modelKey: opt.model, reasoning: next })
    ) {
      onFastUnavailable();
    }
    updateModel(opt.id!, { reasoning: next });
  };
  const setOn = (next: boolean) => commit({ ...r, enabled: next });
  const cycleEffort = () => {
    if (!levels.length) return;
    const i = levels.indexOf(current);
    const next = levels[(i + 1) % levels.length];
    commit({ ...r, enabled: true, default: next });
  };

  return (
    <span
      className="agw-model-reason"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {on && hasEffort && (
        <button
          type="button"
          className="agw-model-effort"
          title="Reasoning effort — click to change"
          onClick={cycleEffort}
        >
          {cap(current)}
        </button>
      )}
      {on && r.type === "budget" && (
        <RowBudget
          modelId={opt.id}
          reasoning={r}
          maxOutputTokens={opt.maxOutputTokens}
          label={opt.label}
        />
      )}
      {showSwitch && (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Reasoning for ${opt.label}`}
          title={`Reasoning ${on ? "on" : "off"}`}
          className="agw-mswitch"
          data-on={on || undefined}
          onClick={() => setOn(!on)}
        >
          <span className="agw-mswitch-knob" />
        </button>
      )}
    </span>
  );
};

// ── Fast lane (Cursor only) ──────────────────────────────────────────────────

/**
 * Cursor's faster lane for one model.
 *
 * Reuses `.agw-model-effort` so a row carrying it keeps the same height as one
 * that doesn't — the chip is a sibling of the effort tier and reads as the
 * same kind of choice, because it is: both change which model id gets sent.
 *
 * Rendered only where the exact thinking and effort choice has a Fast twin.
 * If a previously valid preference becomes unavailable, the chip remains long
 * enough to explain the conflict and let the user turn it off.
 */
const RowFast: React.FC<{
  opt: RichOption;
  on: boolean;
  onToggle: (next: boolean) => void;
}> = ({ opt, on, onToggle }) => {
  if (opt.providerId !== CURSOR_PROVIDER_ID) return null;
  const resolution = resolveCursorFast({
    modelKey: opt.model,
    reasoning: opt.reasoning,
  });
  const available = resolution.ok;
  if (!available && !on) return null;

  return (
    <button
      type="button"
      className="agw-model-effort"
      data-on={on && available ? true : undefined}
      data-unavailable={!available || undefined}
      aria-pressed={on && available}
      aria-label={`Fast mode for ${opt.label}`}
      title={
        !available
          ? "Fast is not available with the selected reasoning setting. Click to turn it off."
          : on
          ? "Fast is on — answers sooner, on your Cursor plan's faster lane"
          : "Fast — answers sooner, on your Cursor plan's faster lane"
      }
      onClick={(e) => {
        e.stopPropagation();
        onToggle(available ? !on : false);
      }}
    >
      {available ? "Fast" : "Fast unavailable"}
    </button>
  );
};

export const ModelSelector: React.FC<{
  /** Horizontal anchor for the popover. "right" (default) suits a right-edge
   *  trigger (bottom action row); "left" suits a left-edge trigger (top row). */
  align?: "left" | "right";
  /** True while the open chat's turn is streaming — drives the chip's live
   *  shimmer (name dims + light sweep) and the ring spinning the mode glyph. */
  streaming?: boolean;
  /**
   * The conversation this picker belongs to. Omit for the open chat; pass it
   * explicitly for a composer that isn't the main one (a chat docked in the
   * side panel), which must show and set ITS thread's model, not the open
   * chat's. `null` is a draft — no thread yet, so the default applies.
   */
  threadId?: string | null;
}> = ({ align = "right", streaming = false, threadId }) => {
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const forThread = threadId === undefined ? openThreadId : threadId;
  const setThreadModel = useAgentChatStore((s) => s.setThreadModel);

  // The model is a property of the CONVERSATION. The store's `selectedModel` is
  // only the default a chat falls back to when it has none of its own — reading
  // it directly is what made every chat display whichever model was picked last
  // anywhere. See `lib/thread-model`.
  const defaultModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const providers = useSettingsStore((s) => s.providers);
  const models = useSettingsStore((s) => s.models);
  const pinned = useAgentChatStore((s) => pinnedThreadModel(s, forThread));
  const selectedModel = useMemo(
    () => normalizeThreadModelSelection(pinned ?? defaultModel, models),
    [pinned, defaultModel, models],
  );

  // Threads created before Cursor's stable model rows can still carry a wire
  // variant such as `cursor-grok-4.6-high-fast`. Display the stable row now and
  // repair the sidecar once, so every later lookup uses the same identity.
  useEffect(() => {
    if (forThread && pinned && selectedModel !== pinned) {
      void setThreadModel(forThread, selectedModel);
    } else if (!pinned && selectedModel !== defaultModel) {
      setSelectedModel(selectedModel);
    }
  }, [forThread, pinned, selectedModel, defaultModel, setThreadModel, setSelectedModel]);

  // Agent/Plan execution mode now lives inside this picker (no separate chip).
  // Same `agentExecutionMode` the settings page writes, so they never disagree.
  const executionMode = useSettingsStore((s) => s.agentExecutionMode);
  const teamEnabled = useSettingsStore((s) => s.teamEnabled);
  const setExecutionMode = useSettingsStore((s) => s.setAgentExecutionMode);

  // The mode of the turn RUNNING on this chat, when it differs from the
  // setting. A task dispatched with `aurora agent --plan` runs read-only for
  // that turn without repointing the window — so while it runs, the setting is
  // not what is happening, and showing it would be a lie the user can watch
  // being contradicted.
  const liveMode = useAgentChatStore((s) =>
    s.currentThreadId ? s.liveModes[s.currentThreadId] : undefined,
  );

  // What is happening now, falling back to what your next message will do.
  const shownMode = liveMode ?? executionMode;
  const planned = shownMode === "plan";
  // A running turn's mode is already fixed; the toggle would silently apply to
  // the NEXT message instead, which is exactly the confusion this fixes.
  const modeLocked = liveMode !== undefined;

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("up");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<Record<string, ModelUsage>>(() => readModelUsage());
  // Cursor's Fast lane, per model. Held here rather than on the model row
  // because it is Cursor's alone — see `lib/model/cursor-fast`.
  const [fast, setFast] = useState<FastPreferences>(() => readFastPreferences());

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Rich catalogue: canonical availability (respects provider-ready gating) joined
  // with the models-slice row for capabilities + reasoning + recency.
  const options = useMemo<RichOption[]>(() => {
    const canonical = useSettingsStore.getState().getAvailableModels();
    return canonical.map((o) => {
      const m = models.find(
        (mm) => mm.providerId === o.providerId && mm.modelKey === o.model,
      );
      const provider = providers.find((p) => p.id === o.providerId);
      const createdAt = m?.createdAt ? Date.parse(m.createdAt) || 0 : 0;
      return {
        providerId: o.providerId,
        providerName: o.providerName,
        model: o.model,
        label: o.label,
        id: m?.id,
        vision: m?.supportsVision ?? provider?.supportsVision ?? false,
        tools: m?.supportsToolStream ?? provider?.supportsToolStream ?? false,
        reasoning: m?.reasoning,
        // Bounds the budget slider: a thinking budget must stay under the
        // model's own output cap or the provider rejects the request.
        maxOutputTokens: m?.maxOutputTokens ?? provider?.maxOutputTokens ?? undefined,
        createdAt,
        sortOrder: m?.sortOrder ?? 0,
      };
    });
  }, [providers, models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.providerName.toLowerCase().includes(q) ||
        o.model.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Provider sections, in the order the user arranged providers; models inside
  // each section in the user's configured order (`sortOrder` ASCENDING — the
  // same order the provider settings page shows; the old flat sort compared it
  // descending, which silently REVERSED the user's arrangement). The stable,
  // grouped layout replaces the old added/used/A–Z cycling, whose "recently
  // added" default degenerated into cross-provider alphabetical soup whenever
  // `createdAt` was missing (every tie fell through to the label).
  // The selected model is lifted OUT of the list into its own "Selected"
  // section at the top, and removed from Recent and from its provider group
  // below. Previously it rendered in up to three places at once, each carrying
  // the active highlight, so the menu looked like it had several selections.
  // It now appears exactly once.
  const selectedRow = useMemo(
    () => filtered.find((o) => `${o.providerId}:${o.model}` === selectedModel) ?? null,
    [filtered, selectedModel],
  );

  const groups = useMemo(() => {
    const byProvider = new Map<string, RichOption[]>();
    for (const o of filtered) {
      // Lifted into the "Selected" section — a provider group that ends up
      // empty as a result is simply not emitted.
      if (`${o.providerId}:${o.model}` === selectedModel) continue;
      const list = byProvider.get(o.providerId);
      if (list) list.push(o);
      else byProvider.set(o.providerId, [o]);
    }
    const ordered: Array<{ providerId: string; providerName: string; items: RichOption[] }> = [];
    const emit = (providerId: string) => {
      const items = byProvider.get(providerId);
      if (!items) return;
      byProvider.delete(providerId);
      items.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
      ordered.push({ providerId, providerName: items[0].providerName, items });
    };
    // The SAME order Settings › Providers draws: the ones Aurora ships with
    // first, then the ones you added. Iterating the raw `providers` array here
    // instead meant the two lists disagreed — the settings rail grouped and
    // ordered them while this menu showed the store's insertion order, so the
    // provider you found third in one place was seventh in the other.
    const { builtIn, custom } = groupProviders(providers);
    for (const p of [...builtIn, ...custom]) emit(p.id);
    for (const id of [...byProvider.keys()]) emit(id); // providers not in the list (defensive)
    return ordered;
    // `selectedModel` is read above (the selected row is lifted into its own
    // section) and now changes when you switch CHATS, not just when you pick —
    // omitting it left the previous chat's model lifted out of its provider
    // group while the new one rendered twice.
  }, [filtered, providers, selectedModel]);

  // "Frequent" strip — what you actually reach for, ranked by frecency rather
  // than by last-touched. Hidden while searching (the query owns the list).
  //
  // `now` is sampled when the menu OPENS, not per render: decay is continuous,
  // so reading the clock during render would make the ranking a moving target
  // and could reorder rows under the cursor mid-click. Frozen per opening, the
  // list stays stable for as long as you are looking at it.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  useEffect(() => {
    if (open) setOpenedAt(Date.now());
  }, [open]);

  const recentRows = useMemo(() => {
    if (query.trim()) return [];
    const byKey = new Map(options.map((o) => [`${o.providerId}:${o.model}`, o]));
    // Never repeat the selected model here — it owns the section above.
    const candidates = [...byKey.keys()].filter((key) => key !== selectedModel);
    return rankByUsage(candidates, recent, openedAt, RECENT_MAX)
      .map((key) => byKey.get(key))
      .filter((o): o is RichOption => Boolean(o));
  }, [options, recent, query, selectedModel, openedAt]);

  const current = useMemo(
    () => options.find((o) => `${o.providerId}:${o.model}` === selectedModel),
    [options, selectedModel],
  );
  // The selection is `"providerId:modelKey"`, and a modelKey may itself contain
  // a colon — Ollama and LM Studio ship `name:tag` ids like `llama3:8b`. Split
  // on the FIRST colon only; `split(":").pop()` returned the TAG ("8b") and
  // called it the model.
  const [selectedProviderId, selectedModelKey] = useMemo(() => {
    if (!selectedModel) return ["", ""] as const;
    const cut = selectedModel.indexOf(":");
    return cut === -1
      ? ([selectedModel, ""] as const)
      : ([selectedModel.slice(0, cut), selectedModel.slice(cut + 1)] as const);
  }, [selectedModel]);

  /**
   * Name of the selected model, resolved so it NEVER degrades to a raw id.
   *
   * `options` only carries models whose provider is "ready" (has a key). A
   * provider that is still loading, or whose key was cleared, drops out — and
   * the old fallback then printed the raw model id. That is why the trigger
   * flipped between a clean name and a long ugly one depending on nothing the
   * user did: same model, different load state. Resolving straight off
   * `providers` (ready or not) with the same formatter the list uses keeps the
   * trigger and the row that feeds it showing one name.
   */
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId),
    [providers, selectedProviderId],
  );

  const currentLabel = useMemo(() => {
    if (current?.label) return current.label;
    if (!selectedModel) return "Select model";
    return formatModelDisplayName(
      selectedModelKey,
      selectedProvider?.modelAliases?.[selectedModelKey],
    );
  }, [current, selectedModel, selectedModelKey, selectedProvider]);

  const currentProviderName =
    current?.providerName ||
    (selectedProvider
      ? formatProviderNickname(selectedProvider.name, selectedProvider.nickname)
      : "");


  // Reasoning effort of the selected model, surfaced on the trigger so the
  // chosen level is visible without opening the picker. Only shown when
  // reasoning is ON *and* the model exposes effort levels.
  const currentEffort = useMemo(() => {
    const r = current?.reasoning;
    if (!r || !reasoningIsOn(r)) return null;
    const levels = r.levels ?? [];
    if (r.type !== "effort" || levels.length === 0) return null;
    const level = String(r.default ?? levels[levels.length - 1] ?? "");
    // "none" is a valid effort level but there's nothing to surface on the chip.
    if (!level || level.toLowerCase() === "none") return null;
    return cap(level);
  }, [current]);

  /**
   * Whether the selected model is running in Cursor's fast lane. On the
   * trigger for the same reason the effort tier is: it changes what the next
   * turn costs in time, and having to open the picker to find out is how a
   * setting gets left on by accident.
   */
  const currentFast = useMemo(
    () =>
      current?.providerId === CURSOR_PROVIDER_ID &&
      !!current.id &&
      fast[current.id] === true &&
      cursorFastAvailable({
        modelKey: current.model,
        reasoning: current.reasoning,
      }),
    [current, fast],
  );

  /**
   * Hover text for the trigger. This used to read "Agent mode · select model" —
   * the MODE, never the model — so the one control whose label is routinely
   * ellipsized was also the one place the full name could not be recovered.
   * Mode still appears, after the thing the user actually pointed at.
   */
  const triggerTitle = useMemo(() => {
    const mode = planned
      ? "Plan mode — read-only"
      : "Agent mode — edits files and runs commands";
    if (!selectedModel) return `Select a model\n${mode}`;
    const lines = [
      currentProviderName ? `${currentProviderName} · ${currentLabel}` : currentLabel,
    ];
    // Only worth a line when the pretty name hides the real id.
    if (selectedModelKey && selectedModelKey !== currentLabel) lines.push(selectedModelKey);
    if (currentEffort) lines.push(`Reasoning: ${currentEffort}`);
    if (currentFast) lines.push("Fast mode on");
    lines.push(mode);
    return lines.join("\n");
  }, [
    planned,
    selectedModel,
    currentProviderName,
    currentLabel,
    selectedModelKey,
    currentEffort,
    currentFast,
  ]);

  const providerCount = useMemo(
    () => new Set(options.map((o) => o.providerName)).size,
    [options],
  );

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setPlacement(below >= MENU_EST_HEIGHT || below >= above ? "down" : "up");
    }
    setQuery("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 30);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // A portaled popover (the budget panel) is a child of `.agw-root`, not
      // of this menu, so plain containment reports it as "outside". Treat
      // anything marked as a portal child as inside its owner.
      if (target?.closest?.("[data-agw-portal-child]")) return;
      if (rootRef.current && !rootRef.current.contains(target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (opt: RichOption) => {
    const selection = `${opt.providerId}:${opt.model}`;
    // Two writes, two different meanings. The conversation is pinned to the
    // pick (persisted on its own sidecar, so reopening it a week later still
    // shows this model); the app-wide selection becomes the default the NEXT
    // new chat inherits, which is what makes "keep using what I just chose"
    // work without leaking the choice back into existing conversations.
    if (forThread) void setThreadModel(forThread, selection);
    setSelectedModel(selection);
    const next = bumpUsage(recent, selection, Date.now());
    setRecent(next);
    writeModelUsage(next);
    setOpen(false);
  };

  const down = placement === "down";

  // One row shape for both the Recent strip and the provider sections. The
  // provider subline only renders where the section header doesn't already
  // say it (i.e. in Recent).
  const renderRow = (opt: RichOption, showProvider: boolean) => {
    const id = `${opt.providerId}:${opt.model}`;
    const active = id === selectedModel;
    return (
      <div
        key={id}
        role="option"
        aria-selected={active}
        tabIndex={0}
        className="agw-model-item"
        data-active={active || undefined}
        onClick={() => pick(opt)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick(opt);
          }
        }}
      >
        <span className="agw-model-meta">
          {/* The name owns the whole left side.
           *
           * It used to share this line with the capability chips, and those were
           * `flex-shrink: 0` while the name was not — so every pixel the row was
           * short came out of the only text that identifies it. Three separate
           * models all rendered as "RESPONSE-GPT…" while VISION and TOOLS sat
           * beside them at full width. Decoration was pinned and identity was
           * negotiable; the glyphs moved to the control cluster to invert that.
           *
           * The provider appears ONLY where no section header states it — the
           * Selected and Recent strips. Under a provider heading it is pure
           * repetition, and it yields width before the name does regardless. */}
          <span className="agw-model-nameline">
            <span
              className="agw-model-name"
              title={
                opt.label === opt.model
                  ? `${opt.providerName} · ${opt.label}`
                  : `${opt.providerName} · ${opt.label}\n${opt.model}`
              }
            >
              {opt.label}
            </span>
            {showProvider && <span className="agw-model-sub">{opt.providerName}</span>}
          </span>
        </span>
        {/* Capabilities are GLYPHS, not words. Spelling out "VISION" and "TOOLS"
         * on every row spent real width restating something true of nearly
         * every model in the list — a label that never varies carries no
         * information. The icon marks the exception; the tooltip says what it
         * means. `shield` is the glyph the settings nav already uses for Tools,
         * so one concept keeps one icon. */}
        <span className="agw-model-controls">
          {opt.vision && (
            <AgentIcon
              name="eye"
              size={13}
              title="Accepts image input"
              className="agw-model-cap"
            />
          )}
          {opt.tools && (
            <AgentIcon
              name="shield"
              size={13}
              title="Supports tool calling"
              className="agw-model-cap"
            />
          )}
          {/* Keyed by the model ROW's id, exactly like the reasoning controls
              above — not by the selection string. A selection is composed at
              runtime and its spelling has changed more than once; a row id is a
              database identity and cannot drift. Every "Fast is on but the
              turn ran slow" bug came from writing under one spelling and
              reading under another. */}
          <RowFast
            opt={opt}
            on={!!opt.id && fast[opt.id] === true}
            onToggle={(next) => {
              if (opt.id) setFast(setFastOn(opt.id, next));
            }}
          />
          <RowReasoning
            opt={opt}
            fastOn={!!opt.id && fast[opt.id] === true}
            onFastUnavailable={() => {
              if (opt.id) setFast(setFastOn(opt.id, false));
            }}
          />
          {active && (
            <AgentIcon name="check" size={15} style={{ color: "var(--agw-accent)" }} />
          )}
        </span>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="agw-model-selector" style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className="agw-composer-pill agw-model-trigger"
        title={triggerTitle}
        // Without this the accessible name is every child span run together —
        // "Claude Opus 4.8 High" — which reads as one nonsense model name.
        aria-label={
          selectedModel
            ? `Model: ${currentProviderName ? `${currentProviderName} ` : ""}${currentLabel}${
                currentEffort ? `, reasoning ${currentEffort}` : ""
              }${currentFast ? ", fast mode on" : ""}. Change model.`
            : "Select a model"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open || undefined}
        data-plan={planned || undefined}
        data-streaming={streaming || undefined}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <span className="agw-model-trigger-modewrap">
          <AgentIcon
            name={planned ? "book-open" : "facet"}
            size={13}
            className="agw-model-trigger-mode"
          />
          <span className="agw-model-trigger-shine" aria-hidden />
        </span>
        <span className="agw-model-trigger-name">{currentLabel}</span>
        {currentEffort && <span className="agw-model-trigger-effort">{currentEffort}</span>}
        {/* Fast is a glyph here, not the word: the pill is the one control
            whose label routinely gets ellipsized, and the menu already spells
            it out. The bolt shimmers only while a turn is actually streaming —
            the same rule the mode glyph follows, so a resting pill stays
            still. `aria-hidden`: the trigger's own accessible name says it. */}
        {currentFast && (
          <span className="agw-model-trigger-fast" aria-hidden="true">
            <AgentIcon name="bolt" size={12} />
            <span className="agw-model-trigger-fast-shine" />
          </span>
        )}
        <AgentIcon
          name="chevron-down"
          size={13}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.18s ease" }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            className="agw-menu agw-model-menu"
            onClick={(e) => e.stopPropagation()}
            // A gentle ease-out — NOT a spring. The old spring was underdamped
            // (ζ≈0.88), so scale overshot past 1 and sprang back — the "small →
            // big → settle" wobble. A tween opens smoothly with no overshoot.
            initial={{ opacity: 0, scale: 0.98, y: down ? -6 : 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: down ? -6 : 6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: "absolute",
              ...(align === "left" ? { left: 0 } : { right: 0 }),
              ...(down ? { top: "calc(100% + 8px)" } : { bottom: "calc(100% + 8px)" }),
              transformOrigin: `${down ? "top" : "bottom"} ${align}`,
              zIndex: 50,
            }}
          >
            {/* Header — Agent/Plan mode toggle · sort. (Count lives only in the
                footer, so it isn't shown twice.) */}
            <div className="agw-model-head">
              <div
                className="agw-model-mode"
                role="radiogroup"
                aria-label="Agent execution mode"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!planned}
                  data-active={!planned || undefined}
                  className="agw-model-mode-btn"
                  disabled={modeLocked}
                  title={
                    modeLocked
                      ? "This turn's mode is fixed while it runs."
                      : "Agent — full access: edits files and runs commands, gated by your approval settings."
                  }
                  onClick={() => setExecutionMode("agent")}
                >
                  <AgentIcon name="facet" size={12} />
                  <span>{teamEnabled ? "Team" : "Agent"}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={planned}
                  data-active={planned || undefined}
                  data-mode="plan"
                  className="agw-model-mode-btn"
                  disabled={modeLocked}
                  title={
                    modeLocked
                      ? "This turn's mode is fixed while it runs."
                      : "Plan — read-only: explores and proposes changes without touching anything."
                  }
                  onClick={() => setExecutionMode("plan")}
                >
                  <AgentIcon name="book-open" size={12} />
                  <span>Plan</span>
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="agw-model-search">
              <AgentIcon name="search" size={14} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {/* List — Recent strip, then one section per provider in the
                user's configured order (models in provider-page order). */}
            <div className="agw-model-list agw-scroll">
              {filtered.length === 0 ? (
                <div className="agw-model-empty">
                  {options.length === 0 ? "No models configured." : "No models match."}
                </div>
              ) : (
                <>
                  {selectedRow && (
                    <div className="agw-model-group">
                      <div className="agw-model-group-label">Selected</div>
                      {renderRow(selectedRow, true)}
                    </div>
                  )}
                  {recentRows.length > 0 && (
                    <div className="agw-model-group">
                      {/* "Frequent", not "Recent" — the ranking is frecency, so
                          a model you lean on stays here through a day of
                          one-off experiments. Calling it Recent would promise
                          an ordering it deliberately no longer has. */}
                      <div className="agw-model-group-label">Frequent</div>
                      {recentRows.map((opt) => renderRow(opt, true))}
                    </div>
                  )}
                  {groups.map((g) => (
                    <div key={g.providerId} className="agw-model-group">
                      <div className="agw-model-group-label">
                        {g.providerName}
                        <span className="agw-model-group-count">{g.items.length}</span>
                      </div>
                      {g.items.map((opt) => renderRow(opt, false))}
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="agw-model-foot">
              {options.length} model{options.length === 1 ? "" : "s"} · {providerCount} provider
              {providerCount === 1 ? "" : "s"}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
