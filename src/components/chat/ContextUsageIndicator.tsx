/**
 * Context Usage Indicator
 * Shows context window usage with turn counts and summarization status
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Database,
  AlertTriangle,
  Layers,
  Zap,
  Sparkles,
  DollarSign,
  TrendingDown,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useContextStore } from '../../store/useContextStore';
import { useSettingsStore } from '../../store/useSettingsStore';

interface ContextUsageIndicatorProps {
  percentage?: number;
  usedTokens?: number;
  totalTokens?: number;
}

// These values are used in SVG which needs computed color values
// We get them from CSS variables at runtime
const getComputedThemeColor = (varName: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
};

const getRingColors = () => ({
  track: getComputedThemeColor('--aurora-common-muted', '#3f3f46'),
  low: getComputedThemeColor('--aurora-chat-usage-low', '#22d3ee'),
  medium: getComputedThemeColor('--aurora-chat-usage-medium', '#facc15'),
  high: getComputedThemeColor('--aurora-chat-usage-high', '#ef4444'),
});

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = (props) => {
  const {
    usedContextTokens,
    contextWindow,
    usagePercentage,
    isOverLimit,
    totalTurns,
    summarizedTurns,
    needsSummarization,
    lastUsage,
  } = useContextStore();

  // DeepSeek / Anthropic prompt-cache telemetry. `cacheReadTokens` is
  // populated by the Rust adapters when the provider reports a cache
  // hit (DeepSeek via `prompt_cache_hit_tokens`, Anthropic via
  // `cache_read_input_tokens`). We display the hit ratio against the
  // total input (cache + non-cache) so users can see how effective the
  // shared prefix is for their workflow.
  const cacheReadTokens = lastUsage?.cacheReadTokens ?? 0;
  const promptTokens = lastUsage?.promptTokens ?? 0;
  const completionTokens = lastUsage?.completionTokens ?? 0;
  const totalInputTokens = cacheReadTokens + promptTokens;
  const cacheHitPercentage =
    totalInputTokens > 0 ? Math.round((cacheReadTokens / totalInputTokens) * 100) : 0;
  const hasCacheHits = cacheReadTokens > 0;

  // Pricing — read from the active model row in the settings store.
  // The three rates are USD per 1M tokens. We only render the cost
  // line when at least cache_miss and output are populated; cache_hit
  // falls back to cache_miss if unset (assumes no discount).
  //
  // IMPORTANT: we subscribe via `getActiveModel()`, NOT
  // `getResolvedActiveModel()`. The latter returns a fresh spread
  // object on every call (see `resolveModel()` in
  // `useSettingsStore.ts`), so Zustand's `useSyncExternalStore`
  // sees a new snapshot reference on every render → infinite loop
  // ("getSnapshot should be cached" / "Maximum update depth exceeded").
  // `getActiveModel()` is just `state.models.find(...)` which returns
  // the same stable model row reference until the array itself
  // changes. Pricing fields live directly on the model row, so we
  // don't need provider-default resolution here anyway.
  const activeModel = useSettingsStore((s) => s.getActiveModel());
  const priceCacheMiss = activeModel?.priceCacheMissPerMtok;
  const priceCacheHit = activeModel?.priceCacheHitPerMtok ?? priceCacheMiss;
  const priceOutput = activeModel?.priceOutputPerMtok;
  const priceCurrency = activeModel?.priceCurrency ?? 'USD';
  const hasPricing =
    priceCacheMiss !== undefined &&
    priceOutput !== undefined &&
    lastUsage !== null;

  // Cost components for the current turn. Numbers are tiny floats —
  // 1M-token unit price × tokens / 1M = raw $. We format with up to
  // 4 fraction digits so DeepSeek-V4-Flash turns (often < $0.001)
  // still render as a meaningful figure rather than rounding to $0.
  const turnCostCachedInput = hasPricing
    ? (cacheReadTokens * (priceCacheHit ?? 0)) / 1_000_000
    : 0;
  const turnCostFreshInput = hasPricing
    ? (promptTokens * (priceCacheMiss ?? 0)) / 1_000_000
    : 0;
  const turnCostOutput = hasPricing
    ? (completionTokens * (priceOutput ?? 0)) / 1_000_000
    : 0;
  const turnCostTotal = turnCostCachedInput + turnCostFreshInput + turnCostOutput;

  // Hypothetical cost if every input token had been a cache miss —
  // lets us show "saved $X.YYZZ" so the value of prefix-stable
  // workflows is immediately visible.
  const turnCostNoCache = hasPricing
    ? (totalInputTokens * (priceCacheMiss ?? 0)) / 1_000_000 + turnCostOutput
    : 0;
  const turnCostSaved = Math.max(0, turnCostNoCache - turnCostTotal);

  const formatCost = (n: number): string => {
    if (!Number.isFinite(n) || n <= 0) return '$0';
    if (n < 0.0001) return `<$0.0001`;
    if (n < 1) return `$${n.toFixed(4)}`;
    if (n < 100) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  };
  // We only render `$` today, but the column exists so future EUR/GBP
  // support is a single-line change in this function.
  void priceCurrency;

  const percentage = props.percentage ?? usagePercentage;
  const usedTokens = props.usedTokens ?? usedContextTokens;
  const totalTokens = props.totalTokens ?? contextWindow;

  // Get theme colors at render time
  const ringColors = getRingColors();

  const size = 18;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;

  const getFillColor = () => {
    if (isOverLimit || percentage >= 80) return ringColors.high;
    if (percentage >= 30) return ringColors.medium;
    return ringColors.low;
  };

  const fillColor = getFillColor();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);

  const formatTokens = (n: number | undefined) => {
    if (n === undefined || n === null) return '0';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  const updateTooltipPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    setTooltipPosition({
      left: rect.left,
      top: rect.top - 12, // small gap above the trigger
    });
  }, []);

  const handleMouseEnter = () => {
    updateTooltipPosition();
    setIsTooltipVisible(true);
  };

  const handleMouseLeave = () => {
    setIsTooltipVisible(false);
  };

  useEffect(() => {
    if (!isTooltipVisible) return;

    const handleViewportChange = () => updateTooltipPosition();
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);

    return () => {
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [isTooltipVisible, updateTooltipPosition]);

  if (usedTokens === 0) return null;

  return (
    <div
      ref={containerRef}
      className="w-fit relative flex items-center cursor-help animate-in fade-in zoom-in duration-300"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
      tabIndex={0}
    >
      {/* Circular Progress */}
      <div className="relative" style={{ width: size, height: size }}>
        <svg 
          width={size} 
          height={size} 
          viewBox={`0 0 ${size} ${size}`}
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={ringColors.track}
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={fillColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ 
              transition: 'stroke-dashoffset 1s ease-out, stroke 0.3s ease'
            }}
          />
        </svg>
      </div>

      {/* Tooltip rendered to body to avoid clipping/stacking issues. */}
      {isTooltipVisible && tooltipPosition && createPortal(
        <div
          className="fixed z-[12000] pointer-events-none"
          style={{
            left: tooltipPosition.left,
            top: tooltipPosition.top,
            transform: 'translateY(-100%)',
          }}
        >
          <div className="bg-sidebar border border-border rounded-lg shadow-xl shadow-black/50 p-2.5 min-w-[200px] backdrop-blur-md">
            <div className="flex items-center gap-1.5 mb-1.5 text-text-secondary text-[10px] uppercase tracking-wider font-semibold">
              <Database size={10} />
              Context Window
            </div>

            {/* Warning Banner */}
            {percentage >= 80 && (
              <div
                className="flex items-center gap-1.5 px-2 py-1 mb-2 rounded text-[10px]"
                style={{
                  backgroundColor: `${ringColors.high}33`,
                  color: ringColors.high,
                }}
              >
                <AlertTriangle size={10} />
                {isOverLimit ? 'Context limit exceeded!' : needsSummarization ? 'Summarization recommended' : 'Context running low'}
              </div>
            )}

            <div className="space-y-1.5">
              {/* Usage percentage */}
              <div className="flex justify-between items-center text-xs">
                <span className="text-text-secondary">Usage</span>
                <span className="font-mono font-medium" style={{ color: fillColor }}>{percentage}%</span>
              </div>

              {/* Progress bar */}
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: ringColors.track }}>
                <div
                  className="h-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, percentage)}%`,
                    backgroundColor: fillColor,
                  }}
                />
              </div>

              {/* Token count */}
              <div className="flex justify-between items-center text-[9px] text-text-disabled font-mono">
                <span>{formatTokens(usedTokens)} / {formatTokens(totalTokens)}</span>
              </div>

              {/* Divider */}
              {totalTurns > 0 && (
                <>
                  <div className="h-px my-1" style={{ backgroundColor: 'var(--aurora-common-border)' }} />
                  
                  {/* Turns info */}
                  <div className="flex justify-between items-center text-xs">
                    <span className="flex items-center gap-1 text-text-secondary">
                      <Layers size={10} />
                      Turns
                    </span>
                    <span className="font-mono text-text-primary">{totalTurns}</span>
                  </div>

                  {/* Summarized turns */}
                  {summarizedTurns > 0 && (
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1 text-text-secondary">
                        <Zap size={10} />
                        Summarized
                      </span>
                      <span className="font-mono" style={{ color: ringColors.low }}>{summarizedTurns}</span>
                    </div>
                  )}
                </>
              )}

              {/* Cache hit telemetry — DeepSeek prompt cache, Anthropic prefix cache */}
              {hasCacheHits && (
                <>
                  <div className="h-px my-1" style={{ backgroundColor: 'var(--aurora-common-border)' }} />
                  <div className="flex justify-between items-center text-xs">
                    <span className="flex items-center gap-1 text-text-secondary">
                      <Sparkles size={10} />
                      Cache hit
                    </span>
                    <span className="font-mono font-medium" style={{ color: ringColors.low }}>
                      {cacheHitPercentage}%
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[9px] text-text-disabled font-mono">
                    <span>
                      {formatTokens(cacheReadTokens)} cached / {formatTokens(totalInputTokens)} input
                    </span>
                  </div>
                </>
              )}

              {/* Cost — surfaces the per-turn $$ when the active model
                  has pricing configured. The cached-input vs fresh-input
                  vs output breakdown makes it obvious why the bill is
                  what it is, and the "saved" line quantifies the cache
                  payoff for the user. Hidden entirely when pricing isn't
                  set on the model row (LMStudio, Ollama, custom) so the
                  tooltip stays tidy for free local providers. */}
              {hasPricing && (
                <>
                  <div className="h-px my-1" style={{ backgroundColor: 'var(--aurora-common-border)' }} />
                  <div className="flex justify-between items-center text-xs">
                    <span className="flex items-center gap-1 text-text-secondary">
                      <DollarSign size={10} />
                      Turn cost
                    </span>
                    <span className="font-mono font-medium text-text-primary">
                      {formatCost(turnCostTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[9px] text-text-disabled font-mono">
                    <span>cached input</span>
                    <span>{formatCost(turnCostCachedInput)}</span>
                  </div>
                  <div className="flex justify-between items-center text-[9px] text-text-disabled font-mono">
                    <span>fresh input</span>
                    <span>{formatCost(turnCostFreshInput)}</span>
                  </div>
                  <div className="flex justify-between items-center text-[9px] text-text-disabled font-mono">
                    <span>output</span>
                    <span>{formatCost(turnCostOutput)}</span>
                  </div>
                  {turnCostSaved > 0 && (
                    <div
                      className="flex justify-between items-center text-[10px] mt-0.5 font-mono"
                      style={{ color: ringColors.low }}
                    >
                      <span className="flex items-center gap-1">
                        <TrendingDown size={9} />
                        saved by cache
                      </span>
                      <span>{formatCost(turnCostSaved)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
