/**
 * Agent Window — model selector [view].
 *
 * The agent window's OWN model picker. A compact trigger pill (mode glyph +
 * model label + effort + chevron) opens a menu:
 *
 *   head      Agent / Plan (Build) or Deep research (Chat)
 *   search    and the Text / Image tabs when Chat has picture models
 *   list      your short list — the selected model and the most used ones —
 *             then "All models", which opens every provider's section in the
 *             same menu (a back row returns). Typing searches everything.
 *
 * Each row shows the reasoning it would run at as a grey word and, when there
 * is something to choose, a `›` that opens `EffortFlyout` beside the menu:
 * choosing a line there sets the reasoning AND picks the model. Focus stays in
 * the search box throughout (the combobox pattern): ↑ ↓ rows, → the reasoning
 * list, ← back, Enter picks.
 *
 * Probe: Documents/aurora-model-picker-rows-designs.html, card 04 (picked
 * 2026-10-16). It replaced the selected-model card of
 * aurora-model-selector-menu-designs.html variant 02.
 */

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import {
  reasoningIsOn,
  useAgentSettingsStore,
  type LLMModel,
} from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  formatModelDisplayName,
  formatProviderNickname,
} from "@/kernel/lib/llm/provider-display";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AGW_DURATION, AGW_EASE } from "@/apps/agent/theme/motion";
import { groupProviders } from "@/apps/agent/services/providers/built-in";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  applyBuildRoster,
  applyChatShortlist,
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
  isModelGroupOpen,
  readModelGroupsOpen,
  readModelScroll,
  readModelTab,
  toggleModelGroup,
  writeModelGroupsOpen,
  writeModelScroll,
  writeModelTab,
  type ModelGroupsOpen,
  type ModelTab,
} from "@/apps/agent/lib/model/model-menu-memory";
import {
  readFastPreferences,
  setFastOn,
  type FastPreferences,
} from "@/apps/agent/lib/model/cursor-fast";
import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";
import {
  canEditWith,
  imageProviderReady,
  isImageModelSelection,
} from "@/apps/agent/services/providers/image-providers";
import { cursorFastAvailable, resolveCursorFast } from "@/apps/agent/services/providers/cursor-run";

import { EffortFlyout, type FlyoutFast } from "./EffortFlyout";
import { ModelRow } from "./ModelRow";
import { levelLabel, optionKey, type RichOption } from "./model-option";
import { placeFlyout, placeMenu, visibleBounds, visibleRect } from "./menu-room";
import { reasoningChoices, reasoningSummary, type ReasoningChoice } from "./model-settings";

/** One line of the list, in drawing order — what the arrow keys walk. */
type ListRow =
  | { kind: "model"; opt: RichOption; showProvider: boolean }
  | { kind: "all" }
  | { kind: "back" };

/** How long the pointer rests on a row before its reasoning list opens. Long
 *  enough to cross other rows on the way to an open list without switching it. */
const HOVER_OPEN_MS = 220;

/**
 * The menu's height cap, in ONE place. Placement (open up or down) is decided
 * before the menu renders, from this number and the room the panel leaves
 * (`menu-room.ts`); the CSS reads the resulting height back through
 * `--agw-model-menu-max-h`. Taller than the old 420 because the card now sits
 * above the list and the list still needs room for a screen of rows.
 */
const MENU_MAX_HEIGHT = 480;
/** Space between the pill and the menu. */
const MENU_GAP = 8;
/** How many most-used models join the selected one in the short list. */
const RECENT_MAX = 5;

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
  const defaultModel = useAgentSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useAgentSettingsStore((s) => s.setSelectedModel);
  const providers = useAgentSettingsStore((s) => s.providers);
  const models = useAgentSettingsStore((s) => s.models);
  const pinned = useAgentChatStore((s) => pinnedThreadModel(s, forThread));
  // Aurora Chat offers a shortlist — up to ten models ticked on the provider
  // page — and a conversation whose model leaves it falls to the next one
  // rather than breaking. Read here as well as in `resolveThreadModel` so the
  // pill shows the model the turn will actually run on.
  //
  // `chatSurface` also gates the Agent/Plan toggle further down — those are
  // ways of working on a project and Aurora Chat has none.
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";
  const chatShortlist = useAgentSettingsStore((s) => s.chatModelShortlist);
  const imageProviders = useAgentSettingsStore((s) => s.imageProviders);
  const selectedModel = useMemo(() => {
    const normalized = normalizeThreadModelSelection(pinned ?? defaultModel, models);
    // Build shows — and runs on — a language model even when the shared default
    // is a picture-making one picked over in Chat. Same call the send path
    // makes, so the pill cannot promise a model the turn will not use.
    return chatSurface
      ? applyChatShortlist(normalized, chatShortlist, models)
      : applyBuildRoster(normalized, models);
  }, [pinned, defaultModel, models, chatSurface, chatShortlist]);

  // Threads created before Cursor's stable model rows can still carry a wire
  // variant such as `cursor-grok-4.6-high-fast`. Display the stable row now and
  // repair the sidecar once, so every later lookup uses the same identity.
  useEffect(() => {
    if (forThread && pinned && selectedModel !== pinned) {
      void setThreadModel(forThread, selectedModel);
    } else if (
      !pinned &&
      selectedModel !== defaultModel &&
      // Never persist Build's substitution for an image default — merely
      // opening Build would otherwise throw away the model Chat is set to.
      !isImageModelSelection(defaultModel)
    ) {
      setSelectedModel(selectedModel);
    }
  }, [forThread, pinned, selectedModel, defaultModel, setThreadModel, setSelectedModel]);

  // Agent/Plan execution mode lives inside this picker (no separate chip).
  // Same `agentExecutionMode` the settings page writes, so they never disagree.
  // The CONVERSATION's mode first, like its model; the window's setting is the
  // default a new chat is born with. Picking writes both, for the same reason
  // picking a model does.
  const defaultMode = useAgentSettingsStore((s) => s.agentExecutionMode);
  const setDefaultMode = useAgentSettingsStore((s) => s.setAgentExecutionMode);
  const threadMode = useAgentChatStore((s) => (forThread ? s.threadModes[forThread] : undefined));
  const setThreadMode = useAgentChatStore((s) => s.setThreadMode);
  const executionMode = threadMode ?? defaultMode;
  const setExecutionMode = (mode: "agent" | "plan") => {
    if (forThread) void setThreadMode(forThread, mode);
    setDefaultMode(mode);
  };
  /** The seed for the NEXT chat. Only meaningful when none is open. */
  const deepResearchNext = useAgentSettingsStore((s) => s.deepResearchNext);
  const setDeepResearchNext = useAgentSettingsStore((s) => s.setDeepResearchNext);
  /**
   * What the OPEN conversation is, which outranks the seed whenever there is
   * one — and cannot be changed, because deep research is fixed at creation.
   */
  // THIS picker's conversation (`forThread`), never the open one: the docked
  // chat's picker used to describe whatever the main pane had open.
  const threadDeepResearch = useAgentChatStore((s) => {
    if (!forThread) return false;
    const found =
      s.allThreads.find((t) => t.id === forThread) ??
      s.threads.find((t) => t.id === forThread);
    return found?.deepResearch === true;
  });
  const deepResearchLocked = !!forThread;
  /**
   * Deep research, as it stands right now — what the OPEN conversation is, or
   * what the next one will be born as. On the composer pill, not only inside
   * the menu: a state you have to open a menu to see is one you forget.
   */
  const deepResearchActive =
    chatSurface && (deepResearchLocked ? threadDeepResearch : deepResearchNext);

  // The mode of the turn RUNNING on this chat, when it differs from the
  // setting. A task dispatched with `aurora agent --plan` runs read-only for
  // that turn without repointing the window — so while it runs, the setting is
  // not what is happening, and showing it would be a lie.
  const liveMode = useAgentChatStore((s) =>
    forThread ? s.liveModes[forThread] : undefined,
  );
  const shownMode = liveMode ?? executionMode;
  const planned = shownMode === "plan";
  // A running turn's mode is already fixed; the toggle would silently apply to
  // the NEXT message instead.
  const modeLocked = liveMode !== undefined;

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("up");
  const [menuHeight, setMenuHeight] = useState(MENU_MAX_HEIGHT);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<Record<string, ModelUsage>>(() => readModelUsage());
  // Which provider sections are open. Read from storage rather than reset per
  // mount: this menu unmounts every time it closes, so component state would
  // shut every group again on each visit and charge the clicks twice.
  const [openGroups, setOpenGroups] = useState<ModelGroupsOpen>(() => readModelGroupsOpen());
  /** A query is on, so it — not the fold — decides what is on screen. */
  const searching = query.trim().length > 0;
  /** The short list, or every provider's section. Each opening starts short. */
  const [view, setView] = useState<"short" | "all">("short");
  /** The row whose reasoning list is open, by position in `visibleRows`. */
  const [fly, setFly] = useState<{ index: number; key: string } | null>(null);
  const [flyIndex, setFlyIndex] = useState(0);
  const [flyPos, setFlyPos] = useState<{ left: number; top: number } | null>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  // Read by the document key listener, which is bound once per opening.
  const flyOpenRef = useRef(false);
  flyOpenRef.current = fly !== null;
  const updateModel = useAgentSettingsStore((s) => s.updateModel);
  const toggleGroup = (providerId: string) => {
    const next = toggleModelGroup(openGroups, providerId);
    setOpenGroups(next);
    writeModelGroupsOpen(next);
  };
  // Cursor's Fast lane, per model ROW id. Held here rather than on the model
  // row because it is Cursor's alone — see `lib/model/cursor-fast`. Keyed by
  // the database id, never the selection string: every "Fast is on but the
  // turn ran slow" bug came from writing under one spelling and reading
  // under another.
  const [fast, setFast] = useState<FastPreferences>(() => readFastPreferences());
  const isFastOn = (o: RichOption | undefined) =>
    !!o?.id &&
    o.providerId === CURSOR_PROVIDER_ID &&
    fast[o.id] === true &&
    cursorFastAvailable({ modelKey: o.model, reasoning: o.reasoning });

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Rich catalogue: canonical availability (respects provider-ready gating) joined
  // with the models-slice row for capabilities + reasoning + recency.
  const options = useMemo<RichOption[]>(() => {
    const canonical = useAgentSettingsStore.getState().getAvailableModels();
    // In Aurora Chat the picker offers the shortlist and nothing else. An empty
    // shortlist is "not curated yet", not "no models", so it offers everything;
    // the alternative is a fresh install opening onto a chat it cannot send from.
    const offered =
      chatSurface && chatShortlist.length > 0
        ? canonical.filter((o) => chatShortlist.includes(`${o.providerId}:${o.model}`))
        : canonical;
    return offered.map((o): RichOption => {
      const m = models.find((mm) => mm.providerId === o.providerId && mm.modelKey === o.model);
      const provider = providers.find((p) => p.id === o.providerId);
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
        createdAt: m?.createdAt ? Date.parse(m.createdAt) || 0 : 0,
        sortOrder: m?.sortOrder ?? 0,
      };
    });
  }, [providers, models, chatSurface, chatShortlist]);

  // Aurora Chat also offers image models, from providers ready to be used. They
  // are NOT mixed into the list above: a picture model answers a different
  // question from every other row, so it gets its own tab. Build never sees
  // them: an agent turn cannot be run by an image model.
  const pictureOptions = useMemo(() => {
    if (!chatSurface) return [];
    return imageProviders.filter(imageProviderReady).flatMap((provider) =>
      provider.models.map((m, index): RichOption => ({
        providerId: provider.id,
        providerName: provider.name,
        model: m.modelKey,
        label: m.label?.trim() || m.modelKey,
        id: m.id,
        vision: false,
        tools: false,
        createdAt: 0,
        sortOrder: index,
        image: true,
        // Both ends have to agree: the provider needs an edit endpoint and the
        // model has to be marked able to use it.
        canEdit: canEditWith(provider, m),
      })),
    );
  }, [chatSurface, imageProviders]);

  /**
   * Text / Image tabs. They answer different questions ("which model should
   * talk to me" vs "which one draws"), so they are not one list. The strip
   * appears ONLY when there is something in the second tab.
   */
  const showTabs = chatSurface && pictureOptions.length > 0;
  // Remembered across openings (the menu unmounts on close). The fallback —
  // used only until a tab has ever been chosen — is the tab the CURRENT model
  // lives in.
  const [tab, setTab] = useState<ModelTab>(() =>
    readModelTab(isImageModelSelection(selectedModel) ? "image" : "text"),
  );
  const chooseTab = (next: ModelTab) => {
    setTab(next);
    writeModelTab(next);
  };

  /** Everything, for looking a selection up — never for drawing the list. */
  const allOptions = useMemo(() => [...options, ...pictureOptions], [options, pictureOptions]);
  const tabOptions = useMemo(() => {
    if (!showTabs) return options;
    return tab === "image" ? pictureOptions : options;
  }, [showTabs, tab, options, pictureOptions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabOptions;
    return tabOptions.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.providerName.toLowerCase().includes(q) ||
        o.model.toLowerCase().includes(q),
    );
  }, [tabOptions, query]);

  // Provider sections, in the order Settings › Providers draws them (built-in
  // first, then added); models inside each in the user's configured order
  // (`sortOrder` ascending — the provider page's order).
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
    const { builtIn, custom } = groupProviders(providers);
    for (const p of [...builtIn, ...custom]) emit(p.id);
    for (const id of [...byProvider.keys()]) emit(id); // providers not in the list (defensive)
    return ordered;
  }, [filtered, providers]);

  // The most used models, ranked by frecency, hidden while searching (the
  // query owns the list). `now` is sampled when the menu OPENS, not per
  // render: decay is continuous, so reading the clock during render could
  // reorder rows under the cursor mid-click.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  useEffect(() => {
    if (open) setOpenedAt(Date.now());
  }, [open]);

  const recentRows = useMemo(() => {
    if (searching) return [];
    const byKey = new Map(tabOptions.map((o) => [optionKey(o), o]));
    // The selected model heads the short list on its own; not twice.
    const candidates = [...byKey.keys()].filter((key) => key !== selectedModel);
    return rankByUsage(candidates, recent, openedAt, RECENT_MAX)
      .map((key) => byKey.get(key))
      .filter((o): o is RichOption => Boolean(o));
  }, [tabOptions, recent, searching, selectedModel, openedAt]);

  const current = useMemo(
    () => allOptions.find((o) => optionKey(o) === selectedModel),
    [allOptions, selectedModel],
  );
  // The selection is `"providerId:modelKey"`, and a modelKey may itself contain
  // a colon — Ollama and LM Studio ship `name:tag` ids like `llama3:8b`. Split
  // on the FIRST colon only.
  const [selectedProviderId, selectedModelKey] = useMemo(() => {
    if (!selectedModel) return ["", ""] as const;
    const cut = selectedModel.indexOf(":");
    return cut === -1
      ? ([selectedModel, ""] as const)
      : ([selectedModel.slice(0, cut), selectedModel.slice(cut + 1)] as const);
  }, [selectedModel]);

  /**
   * Name of the selected model, resolved so it NEVER degrades to a raw id.
   * `options` only carries models whose provider is ready; resolving straight
   * off `providers` with the same formatter keeps the trigger and the row
   * showing one name whatever the load state.
   */
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId),
    [providers, selectedProviderId],
  );
  const currentLabel = useMemo(() => {
    if (current?.label) return current.label;
    if (!selectedModel) return "Select model";
    return formatModelDisplayName(selectedModelKey, selectedProvider?.modelAliases?.[selectedModelKey]);
  }, [current, selectedModel, selectedModelKey, selectedProvider]);
  const currentProviderName =
    current?.providerName ||
    (selectedProvider ? formatProviderNickname(selectedProvider.name, selectedProvider.nickname) : "");

  // Effort of the selected model, on the trigger so it is visible without
  // opening the picker. Only when reasoning is ON and the model has levels.
  const currentEffort = useMemo(() => {
    const r = current?.reasoning;
    if (!r || !reasoningIsOn(r)) return null;
    const levels = r.levels ?? [];
    if (r.type !== "effort" || levels.length === 0) return null;
    const level = String(r.default ?? levels[levels.length - 1] ?? "");
    if (!level || level.toLowerCase() === "none") return null;
    return levelLabel(level);
  }, [current]);

  /** On the trigger for the same reason the effort is: it changes what the next
   *  turn costs in time. */
  const currentFast = isFastOn(current);

  /** Hover text for the trigger: the full name first (the label is routinely
   *  ellipsized), then what else is set, then the mode. */
  const triggerTitle = useMemo(() => {
    const mode = planned ? "Plan mode — read-only" : "Agent mode — edits files and runs commands";
    if (!selectedModel) return `Select a model\n${mode}`;
    const lines = [currentProviderName ? `${currentProviderName} · ${currentLabel}` : currentLabel];
    if (selectedModelKey && selectedModelKey !== currentLabel) lines.push(selectedModelKey);
    if (currentEffort) lines.push(`Reasoning: ${currentEffort}`);
    if (currentFast) lines.push("Fast mode on");
    lines.push(mode);
    return lines.join("\n");
  }, [planned, selectedModel, currentProviderName, currentLabel, selectedModelKey, currentEffort, currentFast]);

  /** The short list: the selected model (when it is in this tab), then the
   *  most used ones. Empty on a fresh install, which opens on everything. */
  const shortRows = useMemo(() => {
    if (searching) return [];
    const head = current && tabOptions.some((o) => optionKey(o) === selectedModel) ? [current] : [];
    return [...head, ...recentRows];
  }, [searching, current, tabOptions, selectedModel, recentRows]);
  const shownView = view === "short" && shortRows.length === 0 ? "all" : view;

  /**
   * Every row on screen, in the order it is drawn — what the arrow keys walk.
   * A model can appear in the short list and in its provider section, which is
   * why rows are addressed by POSITION, not by model id.
   */
  const visibleRows = useMemo(() => {
    const rows: ListRow[] = [];
    if (searching) {
      for (const g of groups) for (const opt of g.items) rows.push({ kind: "model", opt, showProvider: false });
      return rows;
    }
    if (shownView === "short") {
      for (const opt of shortRows) rows.push({ kind: "model", opt, showProvider: true });
      rows.push({ kind: "all" });
      return rows;
    }
    if (shortRows.length > 0) rows.push({ kind: "back" });
    for (const g of groups) {
      if (isModelGroupOpen(openGroups, g.providerId)) {
        for (const opt of g.items) rows.push({ kind: "model", opt, showProvider: false });
      }
    }
    return rows;
  }, [searching, groups, shownView, shortRows, openGroups]);

  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const flyId = `${listId}-fly`;
  /** Where the arrow keys start: the selected model's row, else the top. */
  const homeIndex = useMemo(() => {
    const at = visibleRows.findIndex((r) => r.kind === "model" && optionKey(r.opt) === selectedModel);
    return at === -1 ? 0 : at;
    // Recomputed per opening/query only — see the effect below.
  }, [visibleRows, selectedModel]);
  const [activeIndex, setActiveIndex] = useState(0);
  // A new opening, query, tab or view is a new list: start again from its home row.
  useEffect(() => {
    setActiveIndex(searching ? 0 : homeIndex);
    // `homeIndex` deliberately omitted: folding a section must not yank the
    // highlight back to the selected row while you are mid-list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, open, shownView]);

  // ── Reasoning list ──────────────────────────────────────────────────────────

  /** A model's reasoning choices; none when it has no row to write them to. */
  const choicesFor = (opt: RichOption): ReasoningChoice[] =>
    opt.id ? reasoningChoices(opt.reasoning, opt.maxOutputTokens) : [];
  const fastFor = (opt: RichOption): FlyoutFast | null => {
    if (opt.providerId !== CURSOR_PROVIDER_ID || !opt.id) return null;
    const lane = resolveCursorFast({ modelKey: opt.model, reasoning: opt.reasoning });
    const on = fast[opt.id] === true;
    if (!lane.ok && !on) return null;
    const rowId = opt.id;
    return { available: lane.ok, on, onChange: (next) => setFast(setFastOn(rowId, next)) };
  };
  const hasSettings = (opt: RichOption) => choicesFor(opt).length > 1 || fastFor(opt) !== null;

  const flyRow = fly ? visibleRows[fly.index] : undefined;
  const flyOpt = flyRow?.kind === "model" && optionKey(flyRow.opt) === fly?.key ? flyRow.opt : undefined;
  const flyChoices = flyOpt ? choicesFor(flyOpt) : [];
  const flyFast = flyOpt ? fastFor(flyOpt) : null;

  const closeFly = () => {
    window.clearTimeout(hoverTimer.current);
    setFly(null);
    setFlyPos(null);
  };
  const openFly = (index: number) => {
    const row = visibleRows[index];
    if (row?.kind !== "model" || !hasSettings(row.opt)) return;
    const at = choicesFor(row.opt).findIndex((c) => c.current);
    setFly({ index, key: optionKey(row.opt) });
    setFlyIndex(at === -1 ? 0 : at);
    setFlyPos(null);
  };
  // The list under it changed (a section folded, the view or query moved on):
  // the row it belonged to may be somewhere else now.
  useEffect(() => {
    closeFly();
  }, [visibleRows, open]);

  // Place it once it has a size: beside the menu, level with its row, inside
  // the panel that clips both.
  useLayoutEffect(() => {
    if (!fly || flyPos) return;
    const root = rootRef.current;
    const menu = menuRef.current;
    const flyout = flyRef.current;
    const row = document.getElementById(optionId(fly.index));
    if (!root || !menu || !flyout || !row) return;
    const rootRect = root.getBoundingClientRect();
    const at = placeFlyout(
      menu.getBoundingClientRect(),
      row.getBoundingClientRect(),
      { width: flyout.offsetWidth, height: flyout.offsetHeight },
      visibleRect(root, window.innerWidth, window.innerHeight),
    );
    setFlyPos({ left: at.left - rootRect.left, top: at.top - rootRect.top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fly, flyPos]);

  /** Write a model's reasoning, keeping Cursor's Fast honest. */
  const commitReasoning = (opt: RichOption, next: NonNullable<LLMModel["reasoning"]>) => {
    if (!opt.id) return;
    // A reasoning choice with no Fast twin turns Fast off rather than leaving a
    // preference on that the next turn cannot honour.
    if (
      opt.providerId === CURSOR_PROVIDER_ID &&
      fast[opt.id] === true &&
      !cursorFastAvailable({ modelKey: opt.model, reasoning: next })
    ) {
      setFast(setFastOn(opt.id, false));
    }
    updateModel(opt.id, { reasoning: next });
  };

  const chooseInFly = (index: number) => {
    if (!flyOpt) return;
    if (index === flyChoices.length && flyFast) {
      flyFast.onChange(!(flyFast.on && flyFast.available));
      return;
    }
    const choice = flyChoices[index];
    if (!choice) return;
    commitReasoning(flyOpt, choice.next);
    pick(flyOpt);
  };

  /** Rest on a row: it becomes the active one, and after a moment its
   *  reasoning list opens (or the open one closes). */
  const pointRow = (index: number) => {
    setActiveIndex(index);
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      const row = visibleRows[index];
      if (row?.kind === "model" && hasSettings(row.opt)) {
        if (fly?.index !== index) openFly(index);
      } else if (fly) {
        closeFly();
      }
    }, HOVER_OPEN_MS);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listId]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const trigger = triggerRef.current;
    if (trigger) {
      const place = placeMenu(
        trigger.getBoundingClientRect(),
        visibleBounds(rootRef.current, window.innerHeight),
        MENU_MAX_HEIGHT,
        MENU_GAP,
      );
      setPlacement(place.placement);
      setMenuHeight(place.height);
    }
    setQuery("");
    setView("short");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 30);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // A portaled child (a settings popover opened from inside) is a child of
      // `.agw-root`, not of this menu; marked ones count as inside.
      if (target?.closest?.("[data-agw-portal-child]")) return;
      if (rootRef.current && !rootRef.current.contains(target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc steps back one layer: an open reasoning list first, then the menu.
      if (flyOpenRef.current) {
        setFly(null);
        setFlyPos(null);
        return;
      }
      setOpen(false);
      // Hand focus back to the pill — the search box held it and is about to
      // unmount; without this a keyboard user is dropped onto <body>.
      triggerRef.current?.focus();
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
    const selection = optionKey(opt);
    // Two writes, two meanings. The conversation is pinned to the pick (on its
    // own sidecar); the app-wide selection becomes the default the NEXT new
    // chat inherits, without leaking back into existing conversations.
    if (forThread) void setThreadModel(forThread, selection);
    setSelectedModel(selection);
    const next = bumpUsage(recent, selection, Date.now());
    setRecent(next);
    writeModelUsage(next);
    closeFly();
    setOpen(false);
  };

  /** Enter on a row, or a click: pick a model, or move between the views. */
  const activate = (index: number) => {
    const row = visibleRows[index];
    if (!row) return;
    if (row.kind === "model") pick(row.opt);
    else setView(row.kind === "all" ? "all" : "short");
    searchRef.current?.focus();
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (fly && flyOpt) {
      const lastLine = flyChoices.length - (flyFast ? 0 : 1);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFlyIndex((i) => Math.min(i + 1, lastLine));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFlyIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        chooseInFly(flyIndex);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        closeFly();
      }
      return;
    }
    const last = visibleRows.length - 1;
    // → and ← only steer the list when they could not be moving the caret.
    const caretAtEnd = e.currentTarget.selectionStart === e.currentTarget.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, last));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (!visibleRows[activeIndex]) return;
      e.preventDefault();
      activate(activeIndex);
    } else if (e.key === "ArrowRight" && caretAtEnd) {
      const row = visibleRows[activeIndex];
      if (row?.kind === "model" && hasSettings(row.opt)) {
        e.preventDefault();
        openFly(activeIndex);
      } else if (row?.kind === "all") {
        e.preventDefault();
        activate(activeIndex);
      }
    } else if (e.key === "ArrowLeft" && !query && shownView === "all" && shortRows.length > 0) {
      e.preventDefault();
      setView("short");
    }
  };

  const down = placement === "down";

  // Rows are numbered in drawing order, which is `visibleRows` order, so the
  // arrow keys and the pointer address the same row.
  let rowCursor = 0;
  const renderRow = (opt: RichOption, showProvider: boolean) => {
    const index = rowCursor++;
    return (
      <ModelRow
        key={`${showProvider ? "f" : "g"}:${optionKey(opt)}`}
        opt={opt}
        id={optionId(index)}
        selected={optionKey(opt) === selectedModel}
        active={index === activeIndex}
        showProvider={showProvider}
        effort={opt.id ? reasoningSummary(opt.reasoning, opt.maxOutputTokens) : null}
        hasSettings={hasSettings(opt)}
        settingsOpen={fly?.index === index}
        fastOn={isFastOn(opt)}
        onPoint={() => pointRow(index)}
        onPick={() => pick(opt)}
        onOpenSettings={() => (fly?.index === index ? closeFly() : openFly(index))}
      />
    );
  };
  /** A row that moves between the two views. */
  const renderNav = (kind: "all" | "back") => {
    const index = rowCursor++;
    const active = index === activeIndex;
    return kind === "all" ? (
      <div
        key="nav:all"
        id={optionId(index)}
        role="option"
        aria-selected={false}
        tabIndex={-1}
        className="agw-model-item agw-model-nav"
        data-kbd-active={active || undefined}
        onMouseEnter={() => pointRow(index)}
        onClick={() => activate(index)}
      >
        <AgentIcon name="rows" size={14} className="agw-model-cap" />
        <span className="agw-model-nav-label">All models</span>
        <span className="agw-model-controls">
          <span className="agw-model-group-count">{tabOptions.length}</span>
          <AgentIcon name="chevron-right" size={13} className="agw-model-cap" />
        </span>
      </div>
    ) : (
      <div
        key="nav:back"
        id={optionId(index)}
        role="option"
        aria-selected={false}
        tabIndex={-1}
        className="agw-model-item agw-model-nav agw-model-back"
        data-kbd-active={active || undefined}
        onMouseEnter={() => pointRow(index)}
        onClick={() => activate(index)}
      >
        <AgentIcon name="chevron-right" size={13} className="agw-model-cap agw-model-back-caret" />
        <span className="agw-model-nav-label">All models · {tabOptions.length}</span>
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
              }${currentFast ? ", fast mode on" : ""}${deepResearchActive ? ", deep research" : ""}. Change model.`
            : "Select a model"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open || undefined}
        data-plan={planned || undefined}
        data-deep={deepResearchActive || undefined}
        data-streaming={streaming || undefined}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        {/* The mode glyph. Plan wears the open book on the Build side; on the
            Chat side the same glyph says deep research. The two can never both
            apply, so one slot carries both without ambiguity. */}
        <span className="agw-model-trigger-modewrap">
          <AgentIcon
            name={planned || deepResearchActive ? "book-open" : "facet"}
            size={13}
            className="agw-model-trigger-mode"
          />
          <span className="agw-model-trigger-shine" aria-hidden />
        </span>
        <span className="agw-model-trigger-name">{currentLabel}</span>
        {currentEffort && <span className="agw-model-trigger-effort">{currentEffort}</span>}
        {/* Fast is a glyph here, not the word: the pill is the one control whose
            label routinely gets ellipsized. The bolt shimmers only while a turn
            streams. `aria-hidden`: the trigger's own accessible name says it. */}
        {currentFast && (
          <span className="agw-model-trigger-fast" aria-hidden="true">
            <AgentIcon name="bolt" size={12} />
            <span className="agw-model-trigger-fast-shine" />
          </span>
        )}
        <AgentIcon name="chevron-down" size={13} className="agw-model-trigger-chevron" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            // A dialog holding a search combobox and its list — not itself a
            // listbox, which may only contain options.
            role="dialog"
            aria-label="Choose a model"
            className="agw-menu agw-model-menu"
            onClick={(e) => e.stopPropagation()}
            // A gentle ease-out — NOT a spring. An underdamped spring overshot
            // past 1 and sprang back; a tween opens smoothly.
            initial={{ opacity: 0, scale: 0.98, y: down ? -6 : 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: down ? -6 : 6 }}
            transition={{ duration: AGW_DURATION.base, ease: AGW_EASE.enter }}
            style={{
              position: "absolute",
              ...(align === "left" ? { left: 0 } : { right: 0 }),
              ...(down
                ? { top: `calc(100% + ${MENU_GAP}px)` }
                : { bottom: `calc(100% + ${MENU_GAP}px)` }),
              transformOrigin: `${down ? "top" : "bottom"} ${align}`,
              ["--agw-model-menu-max-h" as string]: `${menuHeight}px`,
            }}
          >
            {/* Head — Agent/Plan (Build) or Deep research (Chat). Agent and Plan
                are ways of working on a project, which Aurora Chat has none of. */}
            <div className="agw-model-head">
              {/* Deep research is set when a conversation is CREATED and fixed
                  after: in an open chat this REPORTS what it is; on a fresh one
                  it decides what the next will be. */}
              {chatSurface &&
                (deepResearchLocked ? (
                  <span
                    className="agw-model-deep"
                    data-on={threadDeepResearch || undefined}
                    data-locked=""
                    title={
                      threadDeepResearch
                        ? "This conversation was started in deep research. That cannot be changed — start a new chat for a quick answer."
                        : "This is an ordinary conversation. Start a new chat to use deep research."
                    }
                  >
                    <AgentIcon name="book-open" size={12} />
                    <span>{threadDeepResearch ? "Deep research" : "Normal"}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="agw-model-deep"
                    data-on={deepResearchNext || undefined}
                    aria-pressed={deepResearchNext}
                    title={
                      deepResearchNext
                        ? "The next chat will be a deep research one: slower, thorough, cited. Click to turn off."
                        : "Start the next chat in deep research: it will take its time, read widely, and cite what it finds."
                    }
                    onClick={() => setDeepResearchNext(!deepResearchNext)}
                  >
                    <AgentIcon name="book-open" size={12} />
                    <span>Deep research</span>
                  </button>
                ))}
              {!chatSurface && (
                <div className="agw-model-mode" role="radiogroup" aria-label="Agent execution mode">
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
                    <span>Agent</span>
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
              )}
            </div>

            <div className="agw-model-search">
              <AgentIcon name="search" size={14} />
              <input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-label="Search models"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={
                  fly
                    ? `${flyId}-${flyIndex}`
                    : visibleRows[activeIndex]
                      ? optionId(activeIndex)
                      : undefined
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={`Search ${options.length + pictureOptions.length} models`}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {/* Two kinds of model, two tabs — under the search, because the
                search runs inside whichever one is open. Absent until an image
                provider is configured. */}
            {showTabs && (
              <div className="agw-model-tabs" role="tablist" aria-label="Kind of model">
                {(
                  [
                    ["text", "Text"],
                    ["image", "Image"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className="agw-model-tab"
                    aria-selected={tab === id}
                    data-on={tab === id || undefined}
                    onClick={() => chooseTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div
              id={listId}
              role="listbox"
              aria-label="Models"
              className="agw-model-list agw-scroll"
              // Hovering a row moves the highlight there; leaving the list must
              // take it away again, or the last row pointed at stays lit as if
              // it were still under the cursor. The next arrow key restarts
              // from the top.
              onMouseLeave={() => {
                setActiveIndex(-1);
                window.clearTimeout(hoverTimer.current);
              }}
              // Put the list back where it was left, in the same frame it paints.
              // Only the full list: the short one is a few rows and starts at the top.
              ref={(node) => {
                if (node && shownView === "all") node.scrollTop = readModelScroll(tab);
              }}
              onScroll={(e) => {
                // The open reasoning list is placed against its row; once the
                // row moves it would point at the wrong model.
                if (fly) closeFly();
                if (shownView === "all") writeModelScroll(tab, e.currentTarget.scrollTop);
              }}
            >
              {filtered.length === 0 ? (
                <div className="agw-model-empty">
                  {tabOptions.length === 0 ? "No models configured." : "No models match."}
                </div>
              ) : !searching && shownView === "short" ? (
                <>
                  {shortRows.map((opt) => renderRow(opt, true))}
                  <div className="agw-model-sep" role="presentation" />
                  {renderNav("all")}
                </>
              ) : (
                <>
                  {!searching && shortRows.length > 0 && renderNav("back")}
                  {groups.map((g) => {
                    // A search owns the list: every match shows whatever the fold
                    // says. The fold state is left alone.
                    const expanded = searching || isModelGroupOpen(openGroups, g.providerId);
                    return (
                      <div key={g.providerId} className="agw-model-group" role="group" aria-label={g.providerName}>
                        <button
                          type="button"
                          className="agw-model-group-label"
                          aria-expanded={expanded}
                          disabled={searching}
                          onClick={() => toggleGroup(g.providerId)}
                          title={expanded ? `Collapse ${g.providerName}` : `Expand ${g.providerName}`}
                        >
                          <AgentIcon name="chevron-down" size={11} className="agw-model-group-caret" />
                          {g.providerName}
                          <span className="agw-model-group-count">{g.items.length}</span>
                        </button>
                        {expanded && g.items.map((opt) => renderRow(opt, false))}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {open && flyOpt && (
        <EffortFlyout
          ref={flyRef}
          idBase={flyId}
          modelLabel={flyOpt.label}
          choices={flyChoices}
          activeIndex={flyIndex}
          fast={flyFast}
          position={flyPos}
          onPoint={setFlyIndex}
          onChoose={chooseInFly}
          onEnter={() => window.clearTimeout(hoverTimer.current)}
        />
      )}
    </div>
  );
};
