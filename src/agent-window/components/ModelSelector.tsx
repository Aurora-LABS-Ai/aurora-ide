/**
 * Agent Window — model selector [view].
 *
 * The agent window's OWN model picker. A compact trigger pill (model glyph +
 * model label + chevron) opens a popover laid out like a real picker:
 * header (title · sort · count) · search · flat rich rows · footer.
 *
 * Each row is self-contained ("all model config in one place"): the model glyph,
 * name, provider, capability badges (Vision / Tools) and — merged in from the old
 * standalone reasoning pill — an inline reasoning on/off switch plus an effort
 * chip. A tiny header **sort** button cycles the list order (recently added /
 * recently used / A–Z); the choice + per-model usage recency persist in
 * localStorage so the picker remembers how you like it.
 *
 * Styling is entirely `--agw-*` (one source of truth) with bespoke `AgentIcon`
 * glyphs — no hardcoded colors.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { reasoningIsOn, useSettingsStore, type LLMModel } from "../../store/useSettingsStore";
import { AgentIcon } from "../shared/AgentIcon";

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
  /** ms epoch for "recently added" sort (0 when unknown). */
  createdAt: number;
  sortOrder: number;
}

const RECENT_KEY = "agw:model-recent";
const MENU_EST_HEIGHT = 420;
/** How many recently-used models surface in the "Recent" strip. */
const RECENT_MAX = 3;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function readRecent(): Record<string, number> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch {
    /* ignore malformed / unavailable */
  }
  return {};
}

// ── Per-row reasoning control (merged from the old ReasoningPicker) ───────────

const RowReasoning: React.FC<{ opt: RichOption }> = ({ opt }) => {
  const updateModel = useSettingsStore((s) => s.updateModel);
  const r = opt.reasoning;
  if (!r || !opt.id) return null;

  const on = reasoningIsOn(r);
  const levels = r.levels ?? [];
  const hasEffort = r.type === "effort" && levels.length > 0;
  // Natively-reasoning models (`toggleable: false`) have no on/off — effort only.
  const showSwitch = r.type === "toggle" || r.toggleable !== false;
  const current = String(r.default ?? levels[levels.length - 1] ?? "");

  const setOn = (next: boolean) =>
    updateModel(opt.id!, { reasoning: { ...r, enabled: next } });
  const cycleEffort = () => {
    if (!levels.length) return;
    const i = levels.indexOf(current);
    const next = levels[(i + 1) % levels.length];
    updateModel(opt.id!, { reasoning: { ...r, enabled: true, default: next } });
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

export const ModelSelector: React.FC<{
  /** Horizontal anchor for the popover. "right" (default) suits a right-edge
   *  trigger (bottom action row); "left" suits a left-edge trigger (top row). */
  align?: "left" | "right";
  /** True while the open chat's turn is streaming — drives the chip's live
   *  shimmer (name dims + light sweep) and the ring spinning the mode glyph. */
  streaming?: boolean;
}> = ({ align = "right", streaming = false }) => {
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const providers = useSettingsStore((s) => s.providers);
  const models = useSettingsStore((s) => s.models);

  // Agent/Plan execution mode now lives inside this picker (no separate chip).
  // Same `agentExecutionMode` the settings page writes, so they never disagree.
  const executionMode = useSettingsStore((s) => s.agentExecutionMode);
  const teamEnabled = useSettingsStore((s) => s.teamEnabled);
  const setExecutionMode = useSettingsStore((s) => s.setAgentExecutionMode);
  const planned = executionMode === "plan";

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("up");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<Record<string, number>>(() => readRecent());

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
  const groups = useMemo(() => {
    const byProvider = new Map<string, RichOption[]>();
    for (const o of filtered) {
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
    for (const p of providers) emit(p.id);
    for (const id of [...byProvider.keys()]) emit(id); // providers not in the list (defensive)
    return ordered;
  }, [filtered, providers]);

  // "Recent" strip — the last few models actually used, newest first. Hidden
  // while searching (the query owns the list) and never shows a lone duplicate
  // of the only group's top row.
  const recentRows = useMemo(() => {
    if (query.trim()) return [];
    return options
      .filter((o) => (recent[`${o.providerId}:${o.model}`] ?? 0) > 0)
      .sort(
        (a, b) =>
          (recent[`${b.providerId}:${b.model}`] ?? 0) -
          (recent[`${a.providerId}:${a.model}`] ?? 0),
      )
      .slice(0, RECENT_MAX);
  }, [options, recent, query]);

  const current = useMemo(
    () => options.find((o) => `${o.providerId}:${o.model}` === selectedModel),
    [options, selectedModel],
  );
  const currentLabel =
    current?.label || (selectedModel ? selectedModel.split(":").pop()! : "Select model");

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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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
    setSelectedModel(`${opt.providerId}:${opt.model}`);
    const next = { ...recent, [`${opt.providerId}:${opt.model}`]: Date.now() };
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* best-effort persistence */
    }
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
          <span className="agw-model-nameline">
            <span className="agw-model-name">{opt.label}</span>
            {opt.vision && (
              <span className="agw-model-cap" title="Vision input">
                <AgentIcon name="eye" size={11} />
                Vision
              </span>
            )}
            {opt.tools && (
              <span className="agw-model-cap" title="Tool streaming">
                Tools
              </span>
            )}
          </span>
          {showProvider && <span className="agw-model-sub">{opt.providerName}</span>}
        </span>
        <span className="agw-model-controls">
          <RowReasoning opt={opt} />
          {active && (
            <AgentIcon name="check" size={15} style={{ color: "var(--agw-accent)" }} />
          )}
        </span>
      </div>
    );
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className="agw-composer-pill agw-model-trigger"
        title={planned ? "Plan mode · select model" : "Agent mode · select model"}
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
                  title="Agent — full access: edits files and runs commands, gated by your approval settings."
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
                  title="Plan — read-only: explores and proposes changes without touching anything."
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
                  {recentRows.length > 0 && (
                    <div className="agw-model-group">
                      <div className="agw-model-group-label">Recent</div>
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
