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
        // VS Code Modern Dark - Mapped to Aurora Theme System variables
        // Editor
        editor: 'var(--aurora-editor-background)',
        foreground: 'var(--aurora-editor-foreground)',

        // Tabs (mapped to sidebar/editor context)
        tabs: 'var(--aurora-title-bar-background)',
        'tabs-active': 'var(--aurora-editor-background)',

        // Sidebar & Panels
        sidebar: 'var(--aurora-sidebar-background)',
        'sidebar-foreground': 'var(--aurora-sidebar-foreground)',
        'panel-header': 'var(--aurora-title-bar-background)', // Fixed: was mapping to text color

        // Core UI
        titlebar: 'var(--aurora-title-bar-background)',
        statusbar: 'var(--aurora-status-bar-background)',

        // Inputs
        input: 'var(--aurora-chat-input-background)',
        'input-border': 'var(--aurora-chat-input-border)',

        // Chat
        'chat-bg': 'var(--aurora-chat-background)',
        'msg-user': 'var(--aurora-chat-user-message)',
        'msg-ai': 'var(--aurora-chat-assistant-message)',

        // Common
        border: 'var(--aurora-common-border)',
        'border-focus': 'var(--aurora-common-primary)',

        // Semantic
        primary: 'var(--aurora-common-primary)',
        'primary-hover': 'var(--aurora-common-primary-hover)',
        'primary-foreground': 'var(--aurora-common-primary-foreground)',

        success: 'var(--aurora-common-success)',
        warning: 'var(--aurora-common-warning)',
        danger: 'var(--aurora-common-error)', // Mapping danger to error
        info: 'var(--aurora-common-info)',

        // Text
        'text-primary': 'var(--aurora-editor-foreground)',
        'text-secondary': 'var(--aurora-sidebar-foreground)',
        'text-disabled': 'var(--aurora-common-secondary-foreground)', // Best approximation
        'text-bright': 'var(--aurora-common-primary-foreground)',
      },
      keyframes: {
        shimmer: {
          '0%': {
            'background-position': '-200% 0',
          },
          '100%': {
            'background-position': '200% 0',
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
        shimmer: 'shimmer 2s linear infinite',
        'pulse-glow': 'pulseGlow 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        breathe: 'breathe 3s ease-in-out infinite',
        'orbit-slow': 'orbitSlow 4s linear infinite',
      },
    },
  },
  plugins: [],
}
