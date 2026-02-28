/**
 * Context Usage Indicator
 * Shows context window usage with turn counts and summarization status
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Database, AlertTriangle, Layers, Zap } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useContextStore } from '../../store/useContextStore';

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
  } = useContextStore();

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
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
