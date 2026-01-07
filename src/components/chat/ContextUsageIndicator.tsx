/**
 * Context Usage Indicator
 * Shows context window usage with turn counts and summarization status
 */

import React from 'react';
import { Database, AlertTriangle, Layers, Zap } from 'lucide-react';
import { useContextStore } from '../../store/useContextStore';

interface ContextUsageIndicatorProps {
  percentage?: number;
  usedTokens?: number;
  totalTokens?: number;
}

const RING_COLORS = {
  track: '#3f3f46',
  low: '#a3e635',
  medium: '#fbbf24',
  high: '#f87171',
};

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

  if (usedTokens === 0) return null;

  const size = 18;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;

  const getFillColor = () => {
    if (isOverLimit || percentage >= 80) return RING_COLORS.high;
    if (percentage >= 30) return RING_COLORS.medium;
    return RING_COLORS.low;
  };

  const fillColor = getFillColor();

  const formatTokens = (n: number | undefined) => {
    if (n === undefined || n === null) return '0';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  return (
    <div className="w-fit group relative flex items-center cursor-help animate-in fade-in zoom-in duration-300">
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
            stroke={RING_COLORS.track}
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

      {/* Tooltip */}
      <div className="absolute bottom-full left-0 mb-3 hidden group-hover:block z-50">
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
                backgroundColor: `${RING_COLORS.high}33`,
                color: RING_COLORS.high,
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
            <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: RING_COLORS.track }}>
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
                    <span className="font-mono" style={{ color: RING_COLORS.low }}>{summarizedTurns}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
