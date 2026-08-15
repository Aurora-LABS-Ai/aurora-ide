/**
 * Agent Window — context-usage ring [view].
 *
 * A compact circular gauge in the conversation header (just before Settings)
 * that shows how much of the model's context window the OPEN chat is using.
 * Hovering reveals a portaled card with the exact tokens, cache-hit telemetry,
 * and what the work has cost. Rows appear only when the data behind them
 * actually exists — no empty rows, and no confident figure over a number
 * nobody measured.
 *
 * THREE different numbers live on this card and they come from three places,
 * because they answer three different questions:
 *
 * - **Used %** — the LATEST request's usage (`byThread`). Every request
 *   resends the whole history, so its input size is exactly how full the
 *   window is now. Correctly overwritten per request.
 * - **This/Last turn** — every request the turn made, summed. Live from the
 *   turn accumulator while streaming, from the transcript once settled. A
 *   turn runs one request per tool iteration; showing only the last one is
 *   what made a thirty-minute turn report the price of its final request.
 * - **This chat** — the whole conversation, grouped by the model that ran
 *   each request and summed as MONEY, so a mid-chat model switch is priced at
 *   each model's own rates.
 *
 * Used context = promptTokens + cacheReadTokens (matches the IDE indicator);
 * the window comes from the conversation's own model. All chrome reads
 * `--agw-*` tokens.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { pinnedThreadModel } from "@/apps/agent/lib/thread/thread-model";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import {
  formatCost,
  formatRequestCount,
  hasCost,
  modelLabel,
  priceUsage,
  type ModelPrices,
  type ModelUsageGroup,
} from "@/apps/agent/lib/cost/cost";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import {
  codexFmtDuration,
  codexUsageGet,
  codexWindowLabel,
  CODEX_PROVIDER_ID,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
} from "@/apps/agent/services/providers/codex";
import type { TokenUsage } from "@/apps/agent/services";

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Ring colour by usage band — green (room) → amber → red (near full). */
function bandColor(pct: number): string {
  if (pct >= 85) return "var(--agw-removed)";
  if (pct >= 60) return "var(--agw-warning)";
  return "var(--agw-added)";
}

/**
 * Codex quota, cached module-level so hover-open doesn't refetch on every
 * mouse pass — the ChatGPT usage endpoint is an authenticated round-trip.
 * One snapshot serves every ring instance for a minute.
 */
let codexUsageCache: { at: number; snap: CodexUsageSnapshot } | null = null;
const CODEX_USAGE_TTL_MS = 60_000;

async function getCodexUsageCached(): Promise<CodexUsageSnapshot | null> {
  if (codexUsageCache && Date.now() - codexUsageCache.at < CODEX_USAGE_TTL_MS) {
    return codexUsageCache.snap;
  }
  try {
    const snap = await codexUsageGet();
    codexUsageCache = { at: Date.now(), snap };
    return snap;
  } catch {
    // Signed out / offline — the tooltip simply omits the quota section.
    return null;
  }
}

/**
 * One priced section of the card — a headline total plus its component lines.
 *
 * Renders nothing when there is nothing true to say. Every state that is not
 * a plain measured total names itself: an approximate total is prefixed `~`,
 * and requests whose model carries no pricing are disclosed by count so the
 * headline is never mistaken for the whole bill.
 */
const CostSection: React.FC<{
  label: string;
  groups: ModelUsageGroup[];
  lookup: (model: string | undefined) => ModelPrices | null;
  /** Shown under the total, e.g. "14 turns · 41 requests". */
  subline?: string;
}> = ({ label, groups, lookup, subline }) => {
  const cost = useMemo(() => priceUsage(groups, lookup), [groups, lookup]);
  // Model KEY only. The raw selection carries the provider row id, which for a
  // user-added provider is a UUID — meaningless to a person and long enough to
  // stretch the card it sits in.
  const unpricedModelLabel = modelLabel(cost.unpricedModels[0]);
  if (!hasCost(cost)) return null;
  const approx = cost.estimated ? "~" : "";
  // Every request priced by the provider itself → the total IS the bill, and
  // the per-line token breakdown does not apply to it.
  const allReported = cost.reportedRequests > 0 && cost.reportedRequests === cost.pricedRequests;
  const lines: Array<[string, number]> = allReported
    ? []
    : [
        ["fresh input", cost.lines.freshInput],
        ["cache write", cost.lines.cacheWrite],
        ["cached input", cost.lines.cachedInput],
        ["output", cost.lines.output],
      ];
  return (
    <>
      <div className="agw-ctx-divider" />
      <div className="agw-ctx-row">
        <span className="agw-ctx-label">{label}</span>
        {/* When NOTHING could be priced there is no figure — say so with a
          * dash. `$0` next to "13 requests not counted" contradicts itself:
          * one claims the work was free, the other says it was never
          * measured. A dash is the only honest headline for "no answer". */}
        <span className="agw-ctx-val">
          {cost.pricedRequests === 0 ? (
            <span style={{ color: "var(--agw-text-subtle)" }}>—</span>
          ) : (
            `${approx}${formatCost(cost.total)}`
          )}
        </span>
      </div>
      {subline && <div className="agw-ctx-sub">{subline}</div>}
      {/* A zero line is dropped rather than shown as $0 — an unused rate is
        * not a charge, and four rows of $0 bury the two that matter. */}
      {lines
        .filter(([, value]) => value > 0)
        .map(([name, value]) => (
          <div key={name} className="agw-ctx-line">
            <span>{name}</span>
            <span>
              {approx}
              {formatCost(value)}
            </span>
          </div>
        ))}
      {/* Where the number came from. A provider-reported figure is the
        * account's actual charge; a computed one is a published list price
        * the gateway may not charge. Users checking cost repeatedly deserve
        * to know which they are looking at. */}
      {allReported ? (
        <div className="agw-ctx-line">
          <span>billed by provider</span>
        </div>
      ) : (
        cost.reportedRequests > 0 && (
          <div className="agw-ctx-line">
            <span>{formatCost(cost.reportedTotal)} billed by provider</span>
            <span>
              {cost.reportedRequests} of {cost.pricedRequests}
            </span>
          </div>
        )
      )}
      {cost.estimated && (
        <div className="agw-ctx-line" style={{ fontStyle: "italic" }}>
          <span>approximate — provider reported no usage</span>
        </div>
      )}
      {/* A sentence, not a label/value pair. It was rendered as two columns of
        * a `space-between` row, so the count and the model name touched with
        * no gap and the raw provider UUID stretched the whole card. It also
        * names the fix — a cost we cannot compute is only actionable if the
        * card says where the missing price goes. */}
      {cost.unpricedRequests > 0 && (
        <div className="agw-ctx-note">
          <strong>
            {cost.unpricedRequests}{" "}
            {cost.unpricedRequests === 1 ? "request" : "requests"} not counted
          </strong>{" "}
          {unpricedModelLabel
            ? `— ${unpricedModelLabel} has no price set. Add one in Settings › Providers.`
            : "— these ran before Aurora recorded which model they used, so they cannot be priced."}
        </div>
      )}
    </>
  );
};

/** One quota row inside the tooltip: "5-hour limit — 63% left · resets in 2h". */
const CodexQuotaRow: React.FC<{ win: CodexUsageWindow; fallbackLabel: string }> = ({
  win,
  fallbackLabel,
}) => {
  const used = Math.min(100, Math.max(0, win.usedPercent));
  const left = Math.max(0, Math.round(100 - used));
  return (
    <>
      <div className="agw-ctx-row">
        <span className="agw-ctx-label">{codexWindowLabel(win, fallbackLabel)}</span>
        <span className="agw-ctx-val" style={{ color: bandColor(used) }}>
          {left}% left
        </span>
      </div>
      <div className="agw-ctx-bar">
        <div
          className="agw-ctx-bar-fill"
          style={{ width: `${used}%`, background: bandColor(used) }}
        />
      </div>
      {win.resetsInSeconds != null && (
        <div className="agw-ctx-sub">resets in {codexFmtDuration(win.resetsInSeconds)}</div>
      )}
    </>
  );
};

export const ContextRing: React.FC = () => {
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const currentThread = useAgentChatStore((s) => s.currentThread);
  const liveUsage = useAgentContextStore((s) =>
    currentThreadId ? s.byThread[currentThreadId] : undefined,
  );
  // Set only in the gap between a compaction rewriting the context and the
  // first request measured against the new shape. Aurora's own arithmetic, and
  // labelled as such — it is a different claim from "the provider reported
  // nothing", which is what conflating the two used to make the card say.
  const projectedTokens = useAgentContextStore((s) =>
    currentThreadId ? s.projectedByThread[currentThreadId] : undefined,
  );

  // Primitive selectors only — returning the object from `getLLMConfig()` /
  // `getResolvedActiveModel()` would hand zustand a fresh reference each render
  // and spin "getSnapshot should be cached". `getActiveModel()` is a stable
  // row lookup; the window is read as a number.
  // The ring measures the OPEN conversation against ITS model's window. Reading
  // the app-wide selection would size the bar by another chat's model — a chat
  // on a 32k model would read as comfortable while sitting inside a 200k window
  // it doesn't have. Both selectors stay safe: one returns a number, the other
  // a stable row from the models array.
  const pinnedModel = useAgentChatStore((s) => pinnedThreadModel(s, s.currentThreadId));
  // Primitive (string) selector — safe to derive from on every render.
  const defaultModel = useSettingsStore((s) => s.selectedModel);
  const selectedModel = pinnedModel ?? defaultModel;
  const contextWindow = useSettingsStore(
    (s) => s.getLLMConfigFor(selectedModel)?.contextWindow ?? 128_000,
  );
  const isCodex = selectedModel.startsWith(`${CODEX_PROVIDER_ID}:`);

  // ── Cost inputs ───────────────────────────────────────────────────
  // The running turn's requests (summed live) and the conversation's total
  // (read back from the transcript). Deliberately separate from `liveUsage`
  // above, which is one request and answers a different question.
  const liveTurnGroups = useAgentContextStore((s) =>
    currentThreadId ? s.liveTurnByThread[currentThreadId] : undefined,
  );
  const breakdown = useAgentContextStore((s) =>
    currentThreadId ? s.breakdownByThread[currentThreadId] : undefined,
  );
  const loadBreakdown = useAgentContextStore((s) => s.loadBreakdown);
  const isStreaming = useAgentChatStore((s) =>
    currentThreadId ? !!s.liveTurns[currentThreadId] : false,
  );

  /**
   * EXACT price lookup — deliberately not `getModelFor`, which falls back to
   * the currently-selected model when a selection is absent or unresolvable.
   * That fallback is right for "which model will this send to" and utterly
   * wrong here: it would price a request whose model was never recorded, or
   * whose model has since been deleted, at today's rates and present the
   * result as measured. A miss must stay a miss so the card can disclose it.
   */
  const models = useSettingsStore((s) => s.models);
  const priceLookup = useCallback(
    (selection: string | undefined): ModelPrices | null => {
      if (!selection) return null;
      // First colon only — a provider id never contains one, a model key can.
      const split = selection.indexOf(":");
      if (split <= 0) return null;
      const providerId = selection.slice(0, split);
      const modelKey = selection.slice(split + 1);
      const model = models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      );
      if (!model) return null;
      return {
        cacheMissPerMtok: model.priceCacheMissPerMtok,
        outputPerMtok: model.priceOutputPerMtok,
        cacheHitPerMtok: model.priceCacheHitPerMtok,
        cacheWritePerMtok: model.priceCacheWritePerMtok,
      };
    },
    [models],
  );

  /**
   * While a turn streams, the live accumulator is the only thing that knows
   * about it — the transcript gains those requests only when the turn ends.
   * Once settled, the transcript wins: it is what survives a reload, and it
   * includes anything the event stream missed.
   */
  const turnGroups = isStreaming
    ? liveTurnGroups ?? []
    : breakdown?.lastTurn ?? liveTurnGroups ?? [];

  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);

  // Loaded from the hover/focus handlers (not an effect): the quota is only
  // wanted while the card is visible, and the module cache absorbs repeat
  // opens. A stale-guard isn't needed — the cache makes late sets idempotent.
  const loadCodexUsage = useCallback(() => {
    if (!isCodex) return;
    void getCodexUsageCached().then((snap) => {
      if (snap) setCodexUsage(snap);
    });
  }, [isCodex]);

  /**
   * Read the conversation's cost basis when the card opens.
   *
   * On open rather than on every turn: parsing a long transcript for a chat
   * nobody is looking at is waste, and the store already knows when its copy
   * went stale. `loadBreakdown` no-ops when a fresh copy is held.
   */
  const loadCost = useCallback(() => {
    if (!currentThreadId) return;
    void loadBreakdown(currentThreadId);
  }, [currentThreadId, loadBreakdown]);
  // Portal INTO `.agw-root` (not document.body) so the `--agw-*` tokens cascade
  // — otherwise the card's `var(--agw-surface-elevated)` resolves to nothing and
  // renders transparent (the "glassmorphic" bug).
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  // Prefer live usage; fall back to the thread's persisted snapshot.
  const usage: TokenUsage | null =
    liveUsage ?? (currentThread?.token_usage as TokenUsage | undefined) ?? null;

  // How much of the window the last measured request occupied — EVERY slice
  // of it. The three input fields are disjoint: Anthropic reports fresh,
  // cache-write and cache-read separately, and Aurora's OpenAI adapter
  // subtracts the cache hit out of `prompt_tokens` so the same sum holds
  // there. Dropping cache-write understated a cache-writing turn by most of
  // its prompt.
  //
  // Output counts too, and is not a cost figure sneaking in: the assistant's
  // reply is re-sent as input on the very next request, so a window that
  // reads comfortable without it is not comfortable. Cost still comes from
  // the turn and chat totals below, which sum every request; this is one
  // request and answers only "how full is it".
  const promptTokens = usage?.promptTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  const measuredTokens =
    promptTokens + cacheWriteTokens + cacheReadTokens + completionTokens;
  // A fresh compaction outranks the last measurement: that request described a
  // context that no longer exists. Holds only until the next real response.
  const isProjected = typeof projectedTokens === "number";
  const usedTokens = isProjected ? projectedTokens : measuredTokens;
  // Local tiktoken estimate (provider didn't report usage) → prefix everything
  // with `~` and add a clarifying note so the number never reads as exact.
  // A projection is approximate too, but for a different reason, and the two
  // must never share a caption — one is about the provider, one is about us.
  const isEstimated = usage?.estimated === true;
  const approx = isEstimated || isProjected ? "~" : "";

  if (!currentThreadId || usedTokens === 0) return null;

  const total = contextWindow > 0 ? contextWindow : 128_000;
  const pct = Math.min(100, Math.round((usedTokens / total) * 100));
  const color = bandColor(pct);

  // Geometry
  const size = 17;
  const stroke = 2.4;
  const radius = (size - stroke) / 2;
  const circ = radius * 2 * Math.PI;
  const offset = circ - (pct / 100) * circ;

  // Cache telemetry (only shown when there were hits).
  // Hit rate is a property of the INPUT only — the completion was generated,
  // not read from or written to cache, so including it would quietly deflate
  // every percentage. Cache writes belong in the denominator: they are prompt
  // the provider had to read in full this time.
  const totalInput = promptTokens + cacheWriteTokens + cacheReadTokens;
  const cacheHitPct =
    totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;
  // Suppressed while projecting: those hits belong to a request built from a
  // context that compaction has since replaced, so reporting them beside the
  // new size would describe two different conversations as one.
  const hasCacheHits = cacheReadTokens > 0 && !isProjected;

  return (
    <div
      ref={attachRoot}
      className="agw-ctx-ring"
      role="img"
      aria-label={`Context used ${isEstimated || isProjected ? "approximately " : ""}${pct}%`}
      tabIndex={0}
      onMouseEnter={() => {
        place();
        setOpen(true);
        loadCodexUsage();
        loadCost();
      }}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => {
        place();
        setOpen(true);
        loadCodexUsage();
        loadCost();
      }}
      onBlur={() => setOpen(false)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in srgb, var(--agw-text) 14%, transparent)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease-out, stroke 0.3s ease" }}
        />
      </svg>

      {open &&
        pos &&
        portalTarget &&
        createPortal(
          <div
            className="agw-ctx-card"
            style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 12000 }}
          >
            <div className="agw-ctx-card-head">
              <AgentIcon name="database" size={11} />
              <span>Context window</span>
            </div>

            <div className="agw-ctx-row">
              <span className="agw-ctx-label">Used</span>
              <span className="agw-ctx-val" style={{ color }}>
                {approx}{pct}%
              </span>
            </div>
            <div className="agw-ctx-bar">
              <div className="agw-ctx-bar-fill" style={{ width: `${pct}%`, background: color }} />
            </div>
            <div className="agw-ctx-sub">
              {approx}{formatTokens(usedTokens)} / {formatTokens(total)} tokens
            </div>
            {isProjected ? (
              <div
                className="agw-ctx-sub"
                style={{ color: "var(--agw-text-subtle)", marginTop: 4, fontStyle: "italic" }}
              >
                Projected after compacting — exact from the next message
              </div>
            ) : (
              isEstimated && (
                <div
                  className="agw-ctx-sub"
                  style={{ color: "var(--agw-text-subtle)", marginTop: 4, fontStyle: "italic" }}
                >
                  Estimated — this provider didn't report token usage
                </div>
              )
            )}

            {hasCacheHits && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-row">
                  <span className="agw-ctx-label">Cache hit</span>
                  <span className="agw-ctx-val" style={{ color: "var(--agw-added)" }}>
                    {cacheHitPct}%
                  </span>
                </div>
                <div className="agw-ctx-sub">
                  {formatTokens(cacheReadTokens)} cached / {formatTokens(totalInput)} input
                </div>
              </>
            )}

            {/* Cost of the whole turn — every request it made, not just the
              * last one. A turn runs one request per tool iteration, so the
              * previous per-request figure under-reported a long turn by the
              * number of tools it used. */}
            <CostSection
              label={isStreaming ? "This turn" : "Last turn"}
              groups={turnGroups}
              lookup={priceLookup}
            />

            {/* The conversation total, summed per model from the transcript so
              * a mid-chat model switch is priced at each model's own rates. */}
            {breakdown && (
              <CostSection
                label="This chat"
                groups={breakdown.byModel}
                lookup={priceLookup}
                subline={formatRequestCount(breakdown.turns, breakdown.requests)}
              />
            )}

            {isCodex && codexUsage && (codexUsage.primary || codexUsage.secondary) && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-card-head">
                  <AgentIcon name="chat" size={11} />
                  <span>ChatGPT plan</span>
                </div>
                {codexUsage.primary && (
                  <CodexQuotaRow win={codexUsage.primary} fallbackLabel="5-hour limit" />
                )}
                {codexUsage.secondary && (
                  <CodexQuotaRow win={codexUsage.secondary} fallbackLabel="Weekly limit" />
                )}
              </>
            )}
          </div>,
          portalTarget,
        )}
    </div>
  );
};
