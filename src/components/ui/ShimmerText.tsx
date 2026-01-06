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

import type { ComponentPropsWithoutRef, CSSProperties, FC } from "react";

export interface ShimmerTextProps extends ComponentPropsWithoutRef<"span"> {
    shimmerWidth?: number;
    animate?: boolean;
}

/**
 * Animated shimmer text component for loading states
 * Uses the same aurora-shine animation as the Aurora name during streaming
 * Smooth light sweep from left to right
 */
export const ShimmerText: FC<ShimmerTextProps> = ({
    children,
    className = "",
    animate = true,
    ...props
}) => {
    if (!animate) {
        return (
            <span className={className} {...props}>
                {children}
            </span>
        );
    }

    // Match the exact shimmer style from ChatMessage Aurora name
    return (
        <span
            style={{
                background: 'linear-gradient(90deg, #60a5fa 0%, #60a5fa 35%, #ffffff 50%, #60a5fa 65%, #60a5fa 100%)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                animation: 'aurora-shine 1s ease-in-out infinite',
            } as CSSProperties}
            className={className}
            {...props}
        >
            {children}
        </span>
    );
};

export default ShimmerText;
