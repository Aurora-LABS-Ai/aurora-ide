/**
 * Registers the bundled Geist variable font under the plain family name
 * `"Geist"`.
 *
 * Why not `import "@fontsource-variable/geist"`: that CSS registers the family
 * as `"Geist Variable"`, but the font stacks users already have persisted in
 * `useAgentThemeStore.customizations` (and older shipped defaults) say
 * `"Geist"` — a name that never matched anything we shipped, so those stacks
 * silently fell through to their next entry, and on machines where that
 * fallback wasn't bundled either, all the way to Segoe UI. Registering the
 * SAME variable woff2 files under the name the stacks actually ask for makes
 * every stored stack resolve without migrating user data.
 *
 * Done through the FontFace API with `?url` asset imports rather than a CSS
 * file, because CSS `url()` cannot resolve a bare package specifier and a
 * `../../../../node_modules/…` relative path breaks on any future move.
 * Geist is SIL OFL 1.1 — bundling in an application is expressly permitted.
 *
 * Latin + latin-ext subsets only: this is UI chrome, and any glyph outside
 * those ranges falls through to the rest of the stack exactly as it does for
 * the other bundled faces. Ranges are copied verbatim from the package's own
 * `index.css` so subsetting behaves identically to the `"Geist Variable"`
 * registration.
 */

import geistLatinUrl from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import geistLatinExtUrl from "@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2?url";

const GEIST_SUBSETS: ReadonlyArray<{ url: string; unicodeRange: string }> = [
  {
    url: geistLatinUrl,
    unicodeRange:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304," +
      "U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
  {
    url: geistLatinExtUrl,
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308," +
      "U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0," +
      "U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
];

let registered = false;

/** Idempotent; a no-op outside a real browser (jsdom has no FontFace). */
export function registerGeistFamily(): void {
  if (
    registered ||
    typeof document === "undefined" ||
    typeof FontFace === "undefined" ||
    !document.fonts
  ) {
    return;
  }
  registered = true;
  for (const subset of GEIST_SUBSETS) {
    const face = new FontFace("Geist", `url(${subset.url}) format("woff2-variations")`, {
      style: "normal",
      weight: "100 900",
      display: "swap",
      unicodeRange: subset.unicodeRange,
    });
    document.fonts.add(face);
  }
}

registerGeistFamily();
