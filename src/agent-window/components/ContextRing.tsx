/**
 * Agent Window — context-usage ring [view].
 *
 * A compact circular gauge in the conversation header (just before Settings)
 * that shows how much of the model's context window the OPEN chat is using.
 * Hovering reveals a clean, portaled card with the exact tokens, cache-hit
 * telemetry, and per-turn cost (only when the data actually exists — no empty
 * rows). Framed as "% used".
 *
 * Data sources (per the open thread):
 *   - live usage from the running turn (`useAgentContextStore`), else
 *   - the thread's persisted `token_usage` (loaded from disk).
 * Used context = promptTokens + cacheReadTokens (matches the IDE indicator);
 * the window comes from the active model. All chrome reads `--agw-*` tokens.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "../shared/AgentIcon";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentContextStore } from "../store/useAgentContextStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import {
  codexFmtDuration,
  codexUsageGet,
  codexWindowLabel,
  CODEX_PROVIDER_ID,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
} from "../../services/codex";
import type { TokenUsage } from "../../services";

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 1) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
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

  // Primitive selectors only — returning the object from `getLLMConfig()` /
  // `getResolvedActiveModel()` would hand zustand a fresh reference each render
  // and spin "getSnapshot should be cached". `getActiveModel()` is a stable
  // row lookup; the window is read as a number.
  const contextWindow = useSettingsStore(
    (s) => s.getLLMConfig()?.contextWindow ?? 128_000,
  );
  const activeModel = useSettingsStore((s) => s.getActiveModel());
  // Primitive (string) selector — safe to derive from on every render.
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const isCodex = selectedModel.startsWith(`${CODEX_PROVIDER_ID}:`);

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

  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const usedTokens = promptTokens + cacheReadTokens;
  // Local tiktoken estimate (provider didn't report usage) → prefix everything
  // with `~` and add a clarifying note so the number never reads as exact.
  const isEstimated = usage?.estimated === true;
  const approx = isEstimated ? "~" : "";

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
  const totalInput = cacheReadTokens + promptTokens;
  const cacheHitPct =
    totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;
  const hasCacheHits = cacheReadTokens > 0;

  // Cost — only when the active model carries pricing.
  const priceMiss = activeModel?.priceCacheMissPerMtok;
  const priceHit = activeModel?.priceCacheHitPerMtok ?? priceMiss;
  const priceOut = activeModel?.priceOutputPerMtok;
  const hasPricing = priceMiss !== undefined && priceOut !== undefined;
  const costCached = hasPricing ? (cacheReadTokens * (priceHit ?? 0)) / 1e6 : 0;
  const costFresh = hasPricing ? (promptTokens * (priceMiss ?? 0)) / 1e6 : 0;
  const costOut = hasPricing ? (completionTokens * (priceOut ?? 0)) / 1e6 : 0;
  const costTotal = costCached + costFresh + costOut;

  return (
    <div
      ref={attachRoot}
      className="agw-ctx-ring"
      role="img"
      aria-label={`Context used ${isEstimated ? "approximately " : ""}${pct}%`}
      tabIndex={0}
      onMouseEnter={() => {
        place();
        setOpen(true);
        loadCodexUsage();
      }}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => {
        place();
        setOpen(true);
        loadCodexUsage();
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
            {isEstimated && (
              <div
                className="agw-ctx-sub"
                style={{ color: "var(--agw-text-subtle)", marginTop: 4, fontStyle: "italic" }}
              >
                Estimated — this provider didn't report token usage
              </div>
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

            {hasPricing && costTotal > 0 && (
              <>
                <div className="agw-ctx-divider" />
                <div className="agw-ctx-row">
                  <span className="agw-ctx-label">Turn cost</span>
                  <span className="agw-ctx-val">{formatCost(costTotal)}</span>
                </div>
                <div className="agw-ctx-line">
                  <span>fresh input</span>
                  <span>{formatCost(costFresh)}</span>
                </div>
                {costCached > 0 && (
                  <div className="agw-ctx-line">
                    <span>cached input</span>
                    <span>{formatCost(costCached)}</span>
                  </div>
                )}
                <div className="agw-ctx-line">
                  <span>output</span>
                  <span>{formatCost(costOut)}</span>
                </div>
              </>
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
