import React from 'react';
import { Database, AlertTriangle } from 'lucide-react';
import { useContextStore } from '../../store/useContextStore';

interface ContextUsageIndicatorProps {
    // Optional overrides (for testing/preview)
    percentage?: number;
    usedTokens?: number;
    totalTokens?: number;
}

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = (props) => {
    // Get real values from context store
    const {
        usedContextTokens,
        contextWindow,
        usagePercentage,
        isNearLimit,
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

    // Color based on usage level
    const getProgressColor = () => {
        if (isOverLimit || percentage >= 95) return 'text-red-500';
        if (isNearLimit || percentage >= 80) return 'text-amber-500';
        if (percentage >= 50) return 'text-yellow-500';
        return 'text-emerald-500';
    };

    const getBarColor = () => {
        if (isOverLimit || percentage >= 95) return 'bg-red-500';
        if (isNearLimit || percentage >= 80) return 'bg-amber-500';
        if (percentage >= 50) return 'bg-yellow-500';
        return 'bg-emerald-500';
    };

    const progressColor = getProgressColor();
    const barColor = getBarColor();

    // Format large numbers
    const formatTokens = (n: number) => {
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return n.toLocaleString();
    };

    return (
        <div className="w-fit group relative flex items-center justify-start cursor-help animate-in fade-in zoom-in duration-300">
            {/* Circular Progress */}
            <div className="relative w-[18px] h-[18px]">
                {/* Background Ring */}
                <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={strokeWidth}
                        className="text-white/10"
                    />
                    {/* Progress Ring */}
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={strokeWidth}
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                        strokeLinecap="round"
                        className={`${progressColor} transition-all duration-1000 ease-out`}
                    />
                </svg>
            </div>

            {/* Tooltip */}
            <div className="absolute bottom-full left-0 mb-3 hidden group-hover:block z-50">
                <div className="bg-[#18181b] border border-white/10 rounded-lg shadow-xl shadow-black/50 p-2.5 min-w-[180px] backdrop-blur-md">
                    <div className="flex items-center gap-1.5 mb-1.5 text-zinc-400 text-[10px] uppercase tracking-wider font-semibold">
                        <Database size={10} />
                        Context Window
                    </div>

                    {/* Warning Banner */}
                    {(isNearLimit || isOverLimit) && (
                        <div className={`flex items-center gap-1.5 px-2 py-1 mb-2 rounded text-[10px] ${
                            isOverLimit ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
                        }`}>
                            <AlertTriangle size={10} />
                            {isOverLimit ? 'Context limit exceeded!' : 'Approaching limit'}
                        </div>
                    )}

                    <div className="space-y-1">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-zinc-400">Usage</span>
                            <span className={`font-mono font-medium ${progressColor}`}>{percentage}%</span>
                        </div>

                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                            <div
                                className={`h-full ${barColor} transition-all duration-500`}
                                style={{ width: `${Math.min(100, percentage)}%` }}
                            />
                        </div>

                        <div className="flex justify-between items-center text-[9px] text-zinc-500 font-mono mt-1">
                            <span>{formatTokens(usedTokens)} / {formatTokens(totalTokens)} tokens</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
