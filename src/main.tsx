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
 * See: src/kernel/types/theme.ts for TypeScript interfaces
 * See: src/apps/ide/services/theme-service.ts for theme utilities
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// ALL bundled typefaces register here — one module, both windows. Which
// family a surface uses is decided in kernel/lib/fonts/stacks.ts.
import '@/kernel/lib/fonts/bundled'
import './index.css'
import { hydrateEnginePrefs } from '@/kernel/lib/prefs/engine-prefs'
import { disableNativeTooltips } from '@/kernel/lib/disable-native-tooltips'
import { startFontProbe } from '@/kernel/lib/fonts/font-probe'
import { applyCachedUiPreferences, preloadBundledFonts } from '@/kernel/lib/fonts/boot'
// Typography recorder — OFF unless switched on with `auroraTypographyDebug.on()`
// in the console. Kept for the next time text looks like it is shifting. It runs
// BEFORE applyCachedUiPreferences so the pre-apply state is its baseline.
import { initTypographyDebug } from '@/kernel/lib/fonts/typography-debug'
import { installErrorReporter } from '@/kernel/lib/diagnostics/error-reporter'
import { startAgentFileSync } from '@/bridge/agent-file-sync'

// Kill all browser-native `title=""` tooltips at the document level so
// the OS chrome tooltip never appears on top of our themed UI. See the
// module's docstring for rationale and trade-offs. Buttons that should
// have hover hints can still use the themed <Tooltip /> wrapper.
disableNativeTooltips()

// Report which font families are ACTUALLY rendering, in both windows, and say
// so again whenever that changes. Font stacks here are user-editable and
// persisted per ORIGIN, so dev and the packaged exe can legitimately disagree —
// this is the only surface that tells you which one you are looking at.
// Call `auroraFonts()` in the console for an on-demand re-read.
startFontProbe()

// Subscribe to the Rust runtime's `agent_file_changed` event so every
// agent file write reaches Monaco, the tab store, and the explorer
// without waiting for a tab close/reopen. Fire-and-forget — the
// service is idempotent, so a hot-reload that re-runs main.tsx won't
// double-subscribe.
void startAgentFileSync().catch((err) => {
  console.warn('[main] startAgentFileSync failed:', err)
})

// Typography must be settled BEFORE first paint, or the window visibly
// re-typesets itself moments after opening:
//   1. the IDE's persisted font/scale used to arrive over async SQLite and
//      re-set the root variables after render — applied here synchronously
//      from the localStorage mirror instead;
//   2. the bundled faces register with `font-display: swap`, so the first
//      paint used the platform fallback and swapped — preloading them (local
//      assets, capped wait) puts the real faces under the first frame.
initTypographyDebug() // No-op unless switched on — see the import note above.

applyCachedUiPreferences()

// The user's preferences (theme, pinned projects, recent models) are the
// engine's, with a copy in browser storage. That copy is made equal to the
// engine's BEFORE the interface's modules load, because their persisted stores
// read it the moment they are created. Hence `App` is imported only after.
async function boot(): Promise<void> {
  await hydrateEnginePrefs()
  // Font preload reads the theme's chosen faces, so it follows the copy too.
  await preloadBundledFonts()
  const { default: App } = await import('./App.tsx')
  // Route web-layer failures into the same aurora.log the backend writes to, so
  // Settings → Diagnostics shows a whole failure rather than its Rust half.
  // Installed after App.tsx has registered its own rejection filter, so an
  // expected cancellation is already marked as handled by the time we see it.
  installErrorReporter()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot().catch((error: unknown) => {
  console.error('[main] Aurora failed to start', error)
})
