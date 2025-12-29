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
        // VS Code Modern Dark - Proper Hierarchy

        // Editor - lightest area where you code
        editor: '#1e1e1e',

        // Tab bar - deeper dark above editor  
        tabs: '#141414',
        'tabs-active': '#1e1e1e',  // Active tab matches editor

        // Sidebar & Chat - same color, darker than editor
        sidebar: '#171717',

        // Panel headers (chat header, explorer header)
        'panel-header': '#1c1c1c',

        // Title bar & Status bar - darkest
        titlebar: '#111111',
        statusbar: '#111111',

        // Input fields - slightly lighter to stand out
        input: '#2d2d2d',
        'input-border': '#404040',

        // Message backgrounds
        'msg-user': '#1a1a1a',
        'msg-ai': '#202020',

        // Borders
        border: '#2b2b2b',
        'border-focus': '#007acc',

        // Accent colors
        primary: '#007acc',
        success: '#89d185',
        warning: '#cca700',
        danger: '#f14c4c',

        // Text colors
        'text-primary': '#d4d4d4',
        'text-secondary': '#808080',
        'text-disabled': '#555555',
        'text-bright': '#ffffff',
      },
      keyframes: {
        shimmer: {
          '0%, 90%, 100%': {
            'background-position': 'calc(-100% - var(--shimmer-width)) 0',
          },
          '30%, 60%': {
            'background-position': 'calc(100% + var(--shimmer-width)) 0',
          },
        },
      },
      animation: {
        shimmer: 'shimmer 8s infinite',
      },
    },
  },
  plugins: [],
}
