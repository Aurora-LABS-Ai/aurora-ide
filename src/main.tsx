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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/manrope/400.css'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import './index.css'
import App from './App.tsx'
import { disableNativeTooltips } from './lib/disable-native-tooltips'
import { startAgentFileSync } from './services/agent-file-sync'

// Kill all browser-native `title=""` tooltips at the document level so
// the OS chrome tooltip never appears on top of our themed UI. See the
// module's docstring for rationale and trade-offs. Buttons that should
// have hover hints can still use the themed <Tooltip /> wrapper.
disableNativeTooltips()

// Subscribe to the Rust runtime's `agent_file_changed` event so every
// agent file write reaches Monaco, the tab store, and the explorer
// without waiting for a tab close/reopen. Fire-and-forget — the
// service is idempotent, so a hot-reload that re-runs main.tsx won't
// double-subscribe.
void startAgentFileSync().catch((err) => {
  console.warn('[main] startAgentFileSync failed:', err)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
