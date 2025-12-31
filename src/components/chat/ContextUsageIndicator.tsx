/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React from 'react';
import { Database, AlertTriangle } from 'lucide-react';
import { useContextStore } from '../../store/useContextStore';

interface ContextUsageIndicatorProps {
    // Optional overrides (for testing/preview)
    percentage?: number;
    usedTokens?: number;
    totalTokens?: number;
}

// Universal colors that work with any theme
const RING_COLORS = {
    track: '#3f3f46',    // neutral grey for free/empty area
    low: '#a3e635',      // bright lime green - works on dark/light
    medium: '#fbbf24',   // bright amber/yellow
    high: '#f87171',     // bright red
};

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = (props) => {
    // Get real values from context store
    const {
        usedContextTokens,
        contextWindow,
        usagePercentage,
        isOverLimit,
    } = useContextStore();

    // Use props as overrides, fallback to store values
    const percentage = props.percentage ?? usagePercentage;
    const usedTokens = props.usedTokens ?? usedContextTokens;
    const totalTokens = props.totalTokens ?? contextWindow;

    // Don't show if no tokens used yet
    if (usedTokens === 0) return null;

    // SVG Config
    const size = 18;
    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (percentage / 100) * circumference;

    // Fill color based on usage level - bright colors that stand out against grey track
    const getFillColor = () => {
        if (isOverLimit || percentage >= 80) return RING_COLORS.high;
        if (percentage >= 30) return RING_COLORS.medium;
        return RING_COLORS.low;
    };

    const fillColor = getFillColor();

    // Format large numbers
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
                    {/* Background/Track Ring - grey for any theme */}
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        fill="none"
                        stroke={RING_COLORS.track}
                        strokeWidth={strokeWidth}
                    />
                    {/* Progress/Fill Ring - brighter color */}
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
                <div className="bg-sidebar border border-border rounded-lg shadow-xl shadow-black/50 p-2.5 min-w-[180px] backdrop-blur-md">
                    <div className="flex items-center gap-1.5 mb-1.5 text-text-secondary text-[10px] uppercase tracking-wider font-semibold">
                        <Database size={10} />
                        Context Window
                    </div>

                    {/* Warning Banner - shows at 80%+ */}
                    {percentage >= 80 && (
                        <div
                            className="flex items-center gap-1.5 px-2 py-1 mb-2 rounded text-[10px]"
                            style={{
                                backgroundColor: `${RING_COLORS.high}33`,
                                color: RING_COLORS.high,
                            }}
                        >
                            <AlertTriangle size={10} />
                            {isOverLimit ? 'Context limit exceeded!' : 'Context running low'}
                        </div>
                    )}

                    <div className="space-y-1">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-text-secondary">Usage</span>
                            <span className="font-mono font-medium" style={{ color: fillColor }}>{percentage}%</span>
                        </div>

                        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: RING_COLORS.track }}>
                            <div
                                className="h-full transition-all duration-500"
                                style={{
                                    width: `${Math.min(100, percentage)}%`,
                                    backgroundColor: fillColor,
                                }}
                            />
                        </div>

                        <div className="flex justify-between items-center text-[9px] text-text-disabled font-mono mt-1">
                            <span>{formatTokens(usedTokens)} / {formatTokens(totalTokens)} tokens</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
