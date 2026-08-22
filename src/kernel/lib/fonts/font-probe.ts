/**
 * Font probe — what is ACTUALLY rendering, printed to the devtools console.
 *
 * Aurora's font stacks are configurable, persisted per ORIGIN in localStorage,
 * and partly bundled at runtime via the FontFace API. That combination has
 * already produced one bug that took a CDP session to diagnose: dev
 * (`localhost:5173`) and the packaged exe (`tauri.localhost`) each hold their
 * own customisation snapshot, so the two render different faces from identical
 * source, and neither the settings UI nor the CSS tells you which one won.
 * See `.knowledge/knowledge.md` (2026-08-08, "Geist bundled").
 *
 * This module answers the only question that matters in that situation — "which
 * family is the browser actually using right now" — and says so again, loudly,
 * whenever the answer changes.
 *
 * ── Why measurement and not `document.fonts.check()` ──────────────────────
 * `check()` is the obvious API and it cannot be trusted here: Chromium returns
 * `true` for a family it has never heard of, because the query is satisfied by
 * the fallback that would be used. It answers "can I paint text", not "is this
 * family present". So availability is decided by rendering the same string in
 * `"Family", <baseline>` and in `<baseline>` alone and comparing widths — if the
 * family exists it displaces the baseline and the widths differ.
 *
 * Three baselines are tried because a single one produces false negatives for
 * any family that happens to be metrically identical to it (a monospace clone
 * measured only against `monospace` looks absent). A family is present if it
 * differs from ANY baseline.
 *
 * `check()` is still reported, separately, as `loaded` — for the faces Aurora
 * bundles itself that genuinely is the question, and a family that measures as
 * present but reports unloaded is the signature of a webfont that lost its race.
 *
 * ── Why DOM layout and not a canvas ───────────────────────────────────────
 * The first version measured with `canvas.measureText` and reported INSTALLED
 * system fonts as missing on the first pass — observed live as
 * `Segoe UI → Segoe UI Variable Text`, two stock Windows faces, one "appearing"
 * seconds after the other. Nothing had loaded in between.
 *
 * The cause is that Chromium's renderer is sandboxed and cannot read the font
 * directory itself: family lookups go to the browser process over
 * `DWriteFontProxy`, and a first reference can return before that resolves. The
 * canvas then measures the fallback and the family looks absent.
 *
 * Two changes fix it. Measurement happens through real DOM layout, which is
 * also simply more faithful — it is the same path that paints the interface,
 * so it answers "what will this text actually use" rather than "what would a
 * canvas use". And every family is referenced once to WARM the lookup before
 * the measurement that counts, so the answer is never the pre-resolution miss.
 *
 * Consequence worth knowing when reading the report: a name can be genuinely
 * installed (it shows in Windows' font list) and still be unusable here, because
 * Windows' GDI enumeration splits a family into per-weight families —
 * "Gotham Book" and "Gotham Black" are GDI names for one DirectWrite family
 * "Gotham". Chromium matches DirectWrite names, so the CSS family is `Gotham`
 * with a weight, and `"Gotham Book"` may legitimately resolve to nothing. That
 * is what the `skipped (missing)` column is for.
 */

/** Generic CSS families — always "available" by definition, never measured. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);

/**
 * Glyphs chosen to maximise width divergence between faces: repeated `m` for
 * advance width, `l`/`i` for narrow forms, `W` for wide caps, and digits
 * because mono/tabular variants differ there most.
 */
const PROBE_TEXT = "mmmmmmmmmmlliWWWWW@1234567890";
const PROBE_SIZE = 72;
const BASELINES = ["monospace", "serif", "sans-serif"] as const;

let probeEl: HTMLSpanElement | null = null;

/**
 * The offscreen span every measurement runs through.
 *
 * Kept alive between reads: creating it per call would re-pay the font lookup
 * warm-up each time and reintroduce exactly the miss this is here to avoid.
 * Deliberately NOT `visibility:hidden` or `display:none` — both can skip the
 * work whose result we are trying to observe. It is parked far offscreen
 * instead, and marked inert + aria-hidden so it can never be reached.
 */
function probeElement(): HTMLSpanElement | null {
  if (probeEl?.isConnected) return probeEl;
  if (!document.body) return null;

  const el = document.createElement("span");
  el.textContent = PROBE_TEXT;
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
  el.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:-99999px",
    "white-space:nowrap",
    "line-height:1",
    `font-size:${PROBE_SIZE}px`,
    // Pinned so an inherited weight/style/tracking cannot shift the widths
    // being compared — the only variable in this measurement is the family.
    "font-weight:400",
    "font-style:normal",
    "font-variant:normal",
    "letter-spacing:normal",
    "pointer-events:none",
  ].join(";");

  document.body.appendChild(el);
  probeEl = el;
  return el;
}

function widthWithFamily(el: HTMLSpanElement, fontFamily: string): number {
  el.style.fontFamily = fontFamily;
  // `getBoundingClientRect`, not `offsetWidth`: the latter rounds to whole
  // pixels, and two faces can differ by less than a pixel across this string.
  return el.getBoundingClientRect().width;
}

/** Quote a family name unless it is already quoted or a bare identifier. */
function cssFamily(family: string): string {
  const trimmed = family.trim();
  if (/^["']/.test(trimmed)) return trimmed;
  return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(trimmed) ? trimmed : `"${trimmed}"`;
}

/** Strip quotes for display and for `document.fonts.check`. */
function bareFamily(family: string): string {
  return family.trim().replace(/^["']|["']$/g, "");
}

/**
 * Is this family actually usable by the renderer right now?
 *
 * "Usable", not "installed" — see the DirectWrite/GDI note in the module
 * docstring. This reports what CSS can resolve, which is the only thing that
 * affects what the user sees.
 */
export function isFamilyAvailable(family: string): boolean {
  const bare = bareFamily(family);
  if (!bare) return false;
  if (GENERIC_FAMILIES.has(bare.toLowerCase())) return true;

  const el = probeElement();
  if (!el) return false;
  const quoted = cssFamily(bare);

  // Warm the lookup. The FIRST reference to a system family can be answered
  // before the browser process resolves it, and its width would then be the
  // fallback's — the exact false negative this discards.
  widthWithFamily(el, `${quoted}, monospace`);

  for (const baseline of BASELINES) {
    const withFamily = widthWithFamily(el, `${quoted}, ${baseline}`);
    const baselineOnly = widthWithFamily(el, baseline);
    if (Math.abs(withFamily - baselineOnly) > 0.5) return true;
  }
  return false;
}

/** Split a CSS font-family stack on top-level commas. */
function familiesOf(stack: string): string[] {
  return stack
    .split(",")
    .map((f) => bareFamily(f))
    .filter(Boolean);
}

export interface FontReading {
  /** Human label for the surface this stack paints. */
  role: string;
  /** The family the browser will actually use — first present in the stack. */
  using: string;
  /** `document.fonts.check` for that family: is a webfont face ready? */
  loaded: boolean;
  /** Families ahead of the winner that are NOT installed — the silent misses. */
  skipped: string;
  /** The full declared stack, verbatim. */
  declared: string;
}

function readStack(role: string, declared: string): FontReading | null {
  const stack = declared.trim();
  if (!stack) return null;

  const families = familiesOf(stack);
  const skipped: string[] = [];
  let using = families[families.length - 1] ?? "(none)";

  for (const family of families) {
    if (isFamilyAvailable(family)) {
      using = family;
      break;
    }
    skipped.push(family);
  }

  let loaded = false;
  try {
    loaded = document.fonts.check(`16px ${cssFamily(using)}`);
  } catch {
    // `check` throws on a font shorthand it cannot parse — a stack we failed to
    // quote correctly. Not knowing is fine; claiming `true` would not be.
    loaded = false;
  }

  return { role, using, loaded, skipped: skipped.join(", ") || "—", declared: stack };
}

function cssVar(el: Element | null, name: string): string {
  if (!el) return "";
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/**
 * Every font stack in play, in both windows.
 *
 * The agent rows are read off `.agw-root` because that is the element the
 * `--agw-*` tokens are set on — reading them from `documentElement` returns
 * empty and would silently report "no agent fonts" inside the agent window.
 * Rows whose source element is absent are skipped, so the IDE window prints
 * IDE rows only and vice versa.
 */
export function readFontState(): FontReading[] {
  const root = document.documentElement;
  const agentRoot = document.querySelector(".agw-root");
  const body = document.body;
  const isAgentWindow = window.location.pathname === "/agent-window";

  const readings: (FontReading | null)[] = [
    readStack("Agent · UI", cssVar(agentRoot, "--agw-font-ui")),
    readStack("Agent · code", cssVar(agentRoot, "--agw-font-code")),
    // `--aurora-ui-font-family` is set on the root in BOTH windows (one
    // bundle), but nothing in the agent window paints with it — reporting it
    // there reads as "this window ignores my font setting", which is false.
    // Same filter `typography-debug.ts` already applies to this row.
    isAgentWindow ? null : readStack("IDE · UI", cssVar(root, "--aurora-ui-font-family")),
    // Not a token but the ground truth: whatever the cascade actually landed on
    // for ordinary text. If this disagrees with the rows above, a stylesheet is
    // overriding the token and the tokens are not the story.
    readStack("body (computed)", body ? getComputedStyle(body).fontFamily : ""),
  ];

  return readings.filter((r): r is FontReading => r !== null);
}

/** Identity of a reading set, for change detection. */
function fingerprint(readings: FontReading[]): string {
  return readings.map((r) => `${r.role}=${r.using}:${r.loaded ? 1 : 0}`).join("|");
}

const BANNER = "color:#3994bc;font-weight:600";
const CHANGE_BANNER =
  "background:#3994bc;color:#fff;font-weight:600;padding:2px 6px;border-radius:3px";

function print(readings: FontReading[], reason: string): void {
  // `console.table` is the whole point of the readable shape above — one row per
  // surface, sortable, and it survives being copied out of devtools.
  console.groupCollapsed(`%c[fonts] ${reason}`, BANNER);
  console.table(
    readings.map((r) => ({
      role: r.role,
      using: r.using,
      loaded: r.loaded,
      "skipped (missing)": r.skipped,
      declared: r.declared,
    })),
  );
  console.groupEnd();
}

function printChange(before: FontReading[] | null, after: FontReading[]): void {
  if (!before) return print(after, "initial");
  const previous = new Map(before.map((r) => [r.role, r]));
  const changes = after.filter((r) => {
    const old = previous.get(r.role);
    return !old || old.using !== r.using || old.loaded !== r.loaded;
  });

  console.log(
    `%c⬤ FONT CHANGED%c  ${changes
      .map((r) => `${r.role}: ${previous.get(r.role)?.using ?? "—"} → ${r.using}`)
      .join("   ·   ")}`,
    CHANGE_BANNER,
    "color:inherit",
  );
  print(after, "after change");
}

let stop: (() => void) | null = null;

/**
 * Start reporting fonts to the console. Idempotent — a hot reload that re-runs
 * the entry module replaces the previous probe rather than stacking a second
 * interval on top of it.
 *
 * Returns a stop function; also exposed as `window.auroraFonts()` for an
 * on-demand re-read from the devtools prompt.
 */
export function startFontProbe(): () => void {
  stop?.();

  // No baseline yet on purpose. This runs from the entry module, BEFORE React
  // mounts and before any bundled face has loaded, so an early reading reports
  // the document defaults and every startup then prints two CHANGE banners for
  // work that is simply the app starting up (`— → Geist`, `Cascadia Code →
  // JetBrains Mono`). A marker that cries wolf at boot is one nobody reads by
  // the time it matters.
  //
  // So the baseline is deferred until the picture is actually settled: the
  // window's own root is mounted AND the font set has finished loading. The
  // deadline is the backstop — a face that never resolves must not cost us the
  // report entirely, so past it we take whatever is true and say so.
  const startedAt = performance.now();
  const BASELINE_DEADLINE_MS = 8000;
  let last: FontReading[] | null = null;

  const isAgentWindow = window.location.pathname === "/agent-window";
  const rootsMounted = () => (isAgentWindow ? !!document.querySelector(".agw-root") : !!document.body);
  const settled = () =>
    (rootsMounted() && document.fonts.status === "loaded") ||
    performance.now() - startedAt > BASELINE_DEADLINE_MS;

  const check = (reason: string) => {
    if (!last) {
      if (!settled()) return;
      last = readFontState();
      print(last, reason === "poll" ? "initial" : reason);
      return;
    }
    const next = readFontState();
    if (fingerprint(next) === fingerprint(last)) return;
    printChange(last, next);
    last = next;
  };

  // Three signals, because a font can change for three unrelated reasons:
  //   - a bundled face finishes loading (`loadingdone`);
  //   - the user edits the stack in Appearance, or a panel/tab swap re-applies
  //     tokens — neither fires any font event, hence the poll;
  //   - returning to the window after changing it in the OTHER window, which
  //     shares nothing but the origin's localStorage.
  const onLoadingDone = () => check("fonts finished loading");
  const onFocus = () => check("window focused");
  const timer = window.setInterval(() => check("poll"), 1500);

  document.fonts.addEventListener("loadingdone", onLoadingDone);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);

  // The usual path to the baseline: everything bundled has resolved, so this is
  // the first reading worth calling the truth.
  void document.fonts.ready.then(() => check("initial"));

  stop = () => {
    window.clearInterval(timer);
    document.fonts.removeEventListener("loadingdone", onLoadingDone);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    // Take the measuring span with it — HMR re-runs the entry module, and an
    // orphan per reload would accumulate offscreen spans for the whole session.
    probeEl?.remove();
    probeEl = null;
    stop = null;
  };

  (window as unknown as { auroraFonts?: () => FontReading[] }).auroraFonts = () => {
    const now = readFontState();
    print(now, "on demand");
    return now;
  };

  return stop;
}
