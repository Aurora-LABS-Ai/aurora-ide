/** @type {import('tailwindcss').Config} */
const auroraColor = (cssVar) => `rgb(from var(${cssVar}) r g b / <alpha-value>)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ============================================================
        // VS Code Modern Dark - Mapped to Aurora Theme System variables
        // ============================================================

        // === Editor ===
        editor: auroraColor('--aurora-editor-background'),
        foreground: auroraColor('--aurora-editor-foreground'),

        // === Tabs ===
        tabs: auroraColor('--aurora-title-bar-background'),
        'tabs-active': auroraColor('--aurora-editor-background'),

        // === Sidebar & Panels ===
        sidebar: auroraColor('--aurora-sidebar-background'),
        'sidebar-foreground': auroraColor('--aurora-sidebar-foreground'),
        'sidebar-item-hover': auroraColor('--aurora-sidebar-item-hover'),
        'sidebar-item-active': auroraColor('--aurora-sidebar-item-active'),
        'sidebar-item-selected': auroraColor('--aurora-sidebar-item-selected'),
        'sidebar-section-header': auroraColor('--aurora-sidebar-section-header'),
        'sidebar-border': auroraColor('--aurora-sidebar-border'),
        'panel-header': auroraColor('--aurora-title-bar-background'),

        // === Core UI ===
        titlebar: auroraColor('--aurora-title-bar-background'),
        statusbar: auroraColor('--aurora-status-bar-background'),

        // === Inputs ===
        input: auroraColor('--aurora-chat-input-background'),
        'input-border': auroraColor('--aurora-chat-input-border'),

        // === Chat ===
        'chat-bg': auroraColor('--aurora-chat-background'),
        'msg-user': auroraColor('--aurora-chat-user-message'),
        'msg-ai': auroraColor('--aurora-chat-assistant-message'),

        // === Borders ===
        border: auroraColor('--aurora-common-border'),
        'border-focus': auroraColor('--aurora-common-primary'),
        'border-hover': auroraColor('--aurora-common-border-hover'),

        // === Primary (Accent) ===
        primary: auroraColor('--aurora-common-primary'),
        'primary-hover': auroraColor('--aurora-common-primary-hover'),
        'primary-foreground': auroraColor('--aurora-common-primary-foreground'),

        // === Secondary ===
        secondary: auroraColor('--aurora-common-secondary'),
        'secondary-hover': auroraColor('--aurora-common-secondary-hover'),
        'secondary-foreground': auroraColor('--aurora-common-secondary-foreground'),

        // === Semantic States ===
        success: auroraColor('--aurora-common-success'),
        'success-foreground': auroraColor('--aurora-common-success-foreground'),
        warning: auroraColor('--aurora-common-warning'),
        'warning-foreground': auroraColor('--aurora-common-warning-foreground'),
        danger: auroraColor('--aurora-common-error'),
        'danger-foreground': auroraColor('--aurora-common-error-foreground'),
        error: auroraColor('--aurora-common-error'),
        'error-foreground': auroraColor('--aurora-common-error-foreground'),
        info: auroraColor('--aurora-common-info'),
        'info-foreground': auroraColor('--aurora-common-info-foreground'),

        // === Muted/Disabled ===
        muted: auroraColor('--aurora-common-muted'),
        'muted-foreground': auroraColor('--aurora-common-muted-foreground'),

        // === Accent (for highlights, file mentions) ===
        accent: auroraColor('--aurora-common-accent'),
        'accent-foreground': auroraColor('--aurora-common-accent-foreground'),
        'accent-muted': auroraColor('--aurora-common-accent-muted'),

        // === Destructive ===
        destructive: auroraColor('--aurora-common-destructive'),
        'destructive-foreground': auroraColor('--aurora-common-destructive-foreground'),

        // === Git/Diff Colors ===
        'diff-added': auroraColor('--aurora-common-diff-added'),
        'diff-added-foreground': auroraColor('--aurora-common-diff-added-foreground'),
        'diff-removed': auroraColor('--aurora-common-diff-removed'),
        'diff-removed-foreground': auroraColor('--aurora-common-diff-removed-foreground'),
        'diff-modified': auroraColor('--aurora-common-diff-modified'),
        'diff-modified-foreground': auroraColor('--aurora-common-diff-modified-foreground'),

        // === Status Indicators ===
        'status-active': auroraColor('--aurora-common-status-active'),
        'status-inactive': auroraColor('--aurora-common-status-inactive'),
        'status-error': auroraColor('--aurora-common-status-error'),
        'status-warning': auroraColor('--aurora-common-status-warning'),

        // === Task/Todo States ===
        'task-pending': auroraColor('--aurora-common-task-pending'),
        'task-progress': auroraColor('--aurora-common-task-in-progress'),
        'task-completed': auroraColor('--aurora-common-task-completed'),
        'task-cancelled': auroraColor('--aurora-common-task-cancelled'),

        // === Security/Connection ===
        'secure': auroraColor('--aurora-common-secure-connection'),
        'insecure': auroraColor('--aurora-common-insecure-connection'),
        'local': auroraColor('--aurora-common-local-connection'),

        // === Quick Actions ===
        'action-analyze': auroraColor('--aurora-common-action-analyze'),
        'action-debug': auroraColor('--aurora-common-action-debug'),
        'action-generate': auroraColor('--aurora-common-action-generate'),
        'action-test': auroraColor('--aurora-common-action-test'),

        // === Checkpoint/Restore ===
        checkpoint: auroraColor('--aurora-common-checkpoint'),
        'checkpoint-foreground': auroraColor('--aurora-common-checkpoint-foreground'),

        // === Context Usage Indicators ===
        'usage-low': auroraColor('--aurora-chat-usage-low'),
        'usage-medium': auroraColor('--aurora-chat-usage-medium'),
        'usage-high': auroraColor('--aurora-chat-usage-high'),

        // === Scrollbar ===
        scrollbar: auroraColor('--aurora-common-scrollbar'),
        'scrollbar-hover': auroraColor('--aurora-common-scrollbar-hover'),

        // === Overlay/Shadow ===
        overlay: auroraColor('--aurora-common-overlay'),
        shadow: auroraColor('--aurora-common-shadow'),

        // === Text Hierarchy ===
        'text-primary': auroraColor('--aurora-editor-foreground'),
        'text-secondary': auroraColor('--aurora-sidebar-foreground'),
        'text-muted': auroraColor('--aurora-common-muted-foreground'),
        'text-disabled': auroraColor('--aurora-common-muted-foreground'),
        'text-bright': auroraColor('--aurora-common-primary-foreground'),

        // === Chat Specific ===
        'thinking-bg': auroraColor('--aurora-chat-thinking-background'),
        'thinking-border': auroraColor('--aurora-chat-thinking-border'),
        'toolcall-bg': auroraColor('--aurora-chat-tool-call-background'),
        'toolcall-border': auroraColor('--aurora-chat-tool-call-border'),
        'code-block': auroraColor('--aurora-chat-code-block'),
        surface: auroraColor('--aurora-chat-surface'),
        'surface-border': auroraColor('--aurora-chat-surface-border'),
        'surface-muted': auroraColor('--aurora-chat-surface-muted'),
      },
      keyframes: {
        shimmer: {
          '0%': {
            'background-position': '200% 0',
          },
          '100%': {
            'background-position': '-200% 0',
          },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.8' },
          '50%': { opacity: '1' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '0.9' },
        },
        orbitSlow: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        shimmer: 'shimmer 0.8s linear infinite',
        'pulse-glow': 'pulseGlow 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        breathe: 'breathe 3s ease-in-out infinite',
        'orbit-slow': 'orbitSlow 4s linear infinite',
      },
    },
  },
  plugins: [],
}
