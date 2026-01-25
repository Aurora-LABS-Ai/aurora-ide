/** @type {import('tailwindcss').Config} */
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
        editor: 'var(--aurora-editor-background)',
        foreground: 'var(--aurora-editor-foreground)',

        // === Tabs ===
        tabs: 'var(--aurora-title-bar-background)',
        'tabs-active': 'var(--aurora-editor-background)',

        // === Sidebar & Panels ===
        sidebar: 'var(--aurora-sidebar-background)',
        'sidebar-foreground': 'var(--aurora-sidebar-foreground)',
        'sidebar-item-hover': 'var(--aurora-sidebar-item-hover)',
        'sidebar-item-active': 'var(--aurora-sidebar-item-active)',
        'sidebar-item-selected': 'var(--aurora-sidebar-item-selected)',
        'sidebar-section-header': 'var(--aurora-sidebar-section-header)',
        'sidebar-border': 'var(--aurora-sidebar-border)',
        'panel-header': 'var(--aurora-title-bar-background)',

        // === Core UI ===
        titlebar: 'var(--aurora-title-bar-background)',
        statusbar: 'var(--aurora-status-bar-background)',

        // === Inputs ===
        input: 'var(--aurora-chat-input-background)',
        'input-border': 'var(--aurora-chat-input-border)',

        // === Chat ===
        'chat-bg': 'var(--aurora-chat-background)',
        'msg-user': 'var(--aurora-chat-user-message)',
        'msg-ai': 'var(--aurora-chat-assistant-message)',

        // === Borders ===
        border: 'var(--aurora-common-border)',
        'border-focus': 'var(--aurora-common-primary)',
        'border-hover': 'var(--aurora-common-border-hover)',

        // === Primary (Accent) ===
        primary: 'var(--aurora-common-primary)',
        'primary-hover': 'var(--aurora-common-primary-hover)',
        'primary-foreground': 'var(--aurora-common-primary-foreground)',

        // === Secondary ===
        secondary: 'var(--aurora-common-secondary)',
        'secondary-hover': 'var(--aurora-common-secondary-hover)',
        'secondary-foreground': 'var(--aurora-common-secondary-foreground)',

        // === Semantic States ===
        success: 'var(--aurora-common-success)',
        'success-foreground': 'var(--aurora-common-success-foreground)',
        warning: 'var(--aurora-common-warning)',
        'warning-foreground': 'var(--aurora-common-warning-foreground)',
        danger: 'var(--aurora-common-error)',
        'danger-foreground': 'var(--aurora-common-error-foreground)',
        error: 'var(--aurora-common-error)',
        'error-foreground': 'var(--aurora-common-error-foreground)',
        info: 'var(--aurora-common-info)',
        'info-foreground': 'var(--aurora-common-info-foreground)',

        // === Muted/Disabled ===
        muted: 'var(--aurora-common-muted)',
        'muted-foreground': 'var(--aurora-common-muted-foreground)',

        // === Accent (for highlights, file mentions) ===
        accent: 'var(--aurora-common-accent)',
        'accent-foreground': 'var(--aurora-common-accent-foreground)',
        'accent-muted': 'var(--aurora-common-accent-muted)',

        // === Destructive ===
        destructive: 'var(--aurora-common-destructive)',
        'destructive-foreground': 'var(--aurora-common-destructive-foreground)',

        // === Git/Diff Colors ===
        'diff-added': 'var(--aurora-common-diff-added)',
        'diff-added-foreground': 'var(--aurora-common-diff-added-foreground)',
        'diff-removed': 'var(--aurora-common-diff-removed)',
        'diff-removed-foreground': 'var(--aurora-common-diff-removed-foreground)',
        'diff-modified': 'var(--aurora-common-diff-modified)',
        'diff-modified-foreground': 'var(--aurora-common-diff-modified-foreground)',

        // === Status Indicators ===
        'status-active': 'var(--aurora-common-status-active)',
        'status-inactive': 'var(--aurora-common-status-inactive)',
        'status-error': 'var(--aurora-common-status-error)',
        'status-warning': 'var(--aurora-common-status-warning)',

        // === Task/Todo States ===
        'task-pending': 'var(--aurora-common-task-pending)',
        'task-progress': 'var(--aurora-common-task-in-progress)',
        'task-completed': 'var(--aurora-common-task-completed)',
        'task-cancelled': 'var(--aurora-common-task-cancelled)',

        // === Security/Connection ===
        'secure': 'var(--aurora-common-secure-connection)',
        'insecure': 'var(--aurora-common-insecure-connection)',
        'local': 'var(--aurora-common-local-connection)',

        // === Quick Actions ===
        'action-analyze': 'var(--aurora-common-action-analyze)',
        'action-debug': 'var(--aurora-common-action-debug)',
        'action-generate': 'var(--aurora-common-action-generate)',
        'action-test': 'var(--aurora-common-action-test)',

        // === Checkpoint/Restore ===
        checkpoint: 'var(--aurora-common-checkpoint)',
        'checkpoint-foreground': 'var(--aurora-common-checkpoint-foreground)',

        // === Context Usage Indicators ===
        'usage-low': 'var(--aurora-chat-usage-low)',
        'usage-medium': 'var(--aurora-chat-usage-medium)',
        'usage-high': 'var(--aurora-chat-usage-high)',

        // === Scrollbar ===
        scrollbar: 'var(--aurora-common-scrollbar)',
        'scrollbar-hover': 'var(--aurora-common-scrollbar-hover)',

        // === Overlay/Shadow ===
        overlay: 'var(--aurora-common-overlay)',
        shadow: 'var(--aurora-common-shadow)',

        // === Text Hierarchy ===
        'text-primary': 'var(--aurora-editor-foreground)',
        'text-secondary': 'var(--aurora-sidebar-foreground)',
        'text-muted': 'var(--aurora-common-muted-foreground)',
        'text-disabled': 'var(--aurora-common-muted-foreground)',
        'text-bright': 'var(--aurora-common-primary-foreground)',

        // === Chat Specific ===
        'thinking-bg': 'var(--aurora-chat-thinking-background)',
        'thinking-border': 'var(--aurora-chat-thinking-border)',
        'toolcall-bg': 'var(--aurora-chat-tool-call-background)',
        'toolcall-border': 'var(--aurora-chat-tool-call-border)',
        'code-block': 'var(--aurora-chat-code-block)',
        surface: 'var(--aurora-chat-surface)',
        'surface-border': 'var(--aurora-chat-surface-border)',
        'surface-muted': 'var(--aurora-chat-surface-muted)',
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
