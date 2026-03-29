import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  
  build: {
    // Increase chunk size warning limit (Monaco is large)
    chunkSizeWarningLimit: 1000,
    
    rollupOptions: {
      // Suppress mixed static/dynamic import warnings (intentional for Tauri)
      onwarn(warning, warn) {
        // Skip warnings about mixed imports - these are intentional
        if (warning.code === 'MIXED_EXPORTS' || 
            warning.message?.includes('dynamically imported by') ||
            warning.message?.includes('dynamic import will not move')) {
          return;
        }
        warn(warning);
      },
      
      output: {
        // Manual chunks for better code splitting
        manualChunks: {
          // Monaco editor is huge - isolate it
          'monaco': ['@monaco-editor/react'],
          
          // React core
          'react-vendor': ['react', 'react-dom'],
          
          // Tauri APIs
          'tauri': [
            '@tauri-apps/api',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-shell',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-os',
            '@tauri-apps/plugin-process',
            '@tauri-apps/plugin-clipboard-manager'
          ],
          
          // UI libraries
          'ui-vendor': [
            'framer-motion',
            'lucide-react',
            'react-resizable-panels',
            'clsx',
            'tailwind-merge'
          ],
          
          // Markdown/syntax highlighting
          'markdown': [
            'react-markdown',
            'react-syntax-highlighter',
            'remark-gfm'
          ],
          
          // State management
          'state': ['zustand'],
          
          // Utilities
          'utils': ['uuid', 'date-fns']
        }
      }
    },
    
    // Minification settings for smaller bundle
    minify: 'esbuild',
    
    // Target modern browsers for smaller output
    target: 'esnext',
    
    // Enable source maps only in dev
    sourcemap: false
  },
  
  // Optimize dependencies
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'zustand',
      '@monaco-editor/react'
    ]
  },
  
  // Dev server config
  server: {
    proxy: {
      '/proxy/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/ollama/, ''),
      },
      '/proxy/lmstudio': {
        target: 'http://localhost:1234',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/lmstudio/, ''),
      },
    },
  },

  // Reduce console output
  logLevel: 'warn'
})
