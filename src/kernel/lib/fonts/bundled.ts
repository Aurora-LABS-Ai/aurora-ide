/**
 * Bundled fonts — the ONE module that registers every typeface Aurora ships.
 *
 * Imported once from `main.tsx`, before either window renders. Registration
 * is cheap (CSS `@font-face` rules; the woff2 files fetch lazily on first
 * use), so both windows share one registration path instead of each product
 * importing its own subset — which is how the agent window ended up with
 * faces the IDE asked for by name but never shipped.
 *
 * The faces:
 *   Inter (static 400/500/600)  — IDE UI default.
 *   Manrope (400/500/600)       — IDE UI preset.
 *   Inter Variable              — agent-window UI default; the variable axis
 *                                 is what makes half-step weights (550/650)
 *                                 real instead of snapping to statics.
 *   IBM Plex Sans (400/500/600) — UI choice with a genuinely different voice
 *                                 from the two grotesks above.
 *   JetBrains Mono (400/600)    — the code face for BOTH windows.
 *   Cascadia Code (400/600)     — named in CODE_FONT_STACK since before it was
 *                                 bundled, so the fallback chain only resolved
 *                                 on machines that happened to have it.
 *   Fira Code (400/600)         — the ligature mono most people expect to find.
 *   Geist Mono (400/600)        — the code counterpart to Geist, which shipped
 *                                 as a UI face with no matching mono.
 *   Geist (variable)            — registered under the plain family name
 *                                 "Geist" via the FontFace API (see ./geist).
 *
 * STATIC packages, not variable ones, for everything except Inter and Geist.
 * `@fontsource-variable/x` registers the family as "X Variable", and a user's
 * persisted stack asks for the plain name — the mismatch that made "Geist"
 * render as a fallback for weeks (knowledge.md, 2026-08-08). Statics carry the
 * plain name for free; only pay the re-registration trick where the variable
 * axis actually earns it.
 *
 * Weights are 400 + 600 for code faces and 400/500/600 for UI faces, matching
 * what the two windows actually ask for. Adding a weight nobody references is
 * pure installer bytes.
 *
 * Which family a surface USES is decided in `./stacks` — never here.
 */

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/cascadia-code/400.css";
import "@fontsource/cascadia-code/600.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/600.css";
import "./geist";
