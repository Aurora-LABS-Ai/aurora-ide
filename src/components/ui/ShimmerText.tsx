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
 * Shows a shiny gradient animation sweeping left to right over stable text
 */
export const ShimmerText: FC<ShimmerTextProps> = ({
    children,
    className = "",
    shimmerWidth = 100,
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

    return (
        <span
            style={
                {
                    "--shimmer-width": `${shimmerWidth}px`,
                } as CSSProperties
            }
            className={`
                inline-block
                text-neutral-600/70 
                dark:text-neutral-400/70
                
                /* Shine effect */
                animate-shimmer 
                bg-clip-text 
                text-transparent 
                bg-no-repeat
                
                /* Shine gradient - Start with text color, flash white, end with text color */
                bg-gradient-to-r 
                from-zinc-500 
                via-zinc-200 
                to-zinc-500
                
                ${className}
            `.trim().replace(/\s+/g, ' ')}
            {...props}
        >
            {children}
        </span>
    );
};

export default ShimmerText;
