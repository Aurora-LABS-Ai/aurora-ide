/**
 * Typography recorder — OFF by default, kept for the next time text looks wrong.
 *
 * Nothing runs unless it is switched on, so the cost when idle is the module's
 * own bytes and one localStorage read at boot. To use it:
 *
 *     auroraTypographyDebug.on()    // starts now, and on every reload after
 *     auroraTypographyDebug.off()   // stops and forgets
 *     auroraTypographyDebug.log()   // print the current log without the panel
 *
 * `on()` then RELOAD is the meaningful sequence: the recorder's whole value is
 * that it starts before the first paint, so a session switched on halfway has
 * no startup data in it. The panel says so rather than presenting a partial
 * record as a complete one.
 *
 * ── What it answers ───────────────────────────────────────────────────────
 * "Is the text actually changing size/face after the window opens, or am I
 * seeing things?" A readout of the CURRENT values cannot answer that: the
 * suspected shift happens in the first second, before any panel could mount.
 * So this RECORDS from the entry module — before React — samples every frame
 * for the first few seconds, and keeps a timestamped list of every value that
 * changed. By the time you look, the evidence already exists.
 *
 * ── Why it duplicates nothing ─────────────────────────────────────────────
 * `font-probe.ts` already answers "which family is actually rendering" using
 * real DOM layout measurement (see its docstring — `document.fonts.check()`
 * lies here). This calls `readFontState()` for that and adds the two things it
 * deliberately does not do: SIZES, and reporting during startup. The probe
 * defers its baseline until fonts settle precisely so it does not cry wolf at
 * boot — which is the exact window under suspicion, hence this separate tool.
 *
 * ── Why the panel hardcodes its own font and colors ───────────────────────
 * Against the project's usual rule (see the notice atop `main.tsx`). A
 * diagnostic must not inherit the tokens it is measuring: if this panel used
 * `--agw-font-ui` it would re-typeset itself at the same instant as the text
 * it is reporting on, and its own numbers would be unreadable while the event
 * it exists to capture takes place. It pins a system mono stack that Aurora
 * never touches.
 *
 * ── The three things it watches ───────────────────────────────────────────
 *   Text    real elements — size, line-height, weight, and the RENDERED WIDTH
 *           of a fixed sample string. Width is the ground truth: if the face
 *           swaps to a metrically different one, width moves even when every
 *           number stays put. That is the startup swap's signature.
 *   Faces   which family the browser actually resolved, via font-probe.
 *   Values  the CSS variables that feed all of the above, so a change can be
 *           traced to its input rather than just observed.
 */

import { readFontState } from "./font-probe";

// ── What is watched ──────────────────────────────────────────────────────

interface TextTarget {
  key: string;
  /** Plain-language name — what a person would call this text. */
  label: string;
  /** Where it comes from, for tracing. Shown muted. */
  hint: string;
  /** Which window this row belongs to. See `IS_AGENT_WINDOW`. */
  window: "agent" | "ide" | "both";
  find: () => Element | null;
}

/**
 * Both products ship from one bundle, so a naive watch list reports the other
 * window's typography as if it mattered here. It does not: in the agent window
 * every surface you read sits under `.agw-root` with its own `--agw-*` tokens,
 * and the IDE's font/scale variables change nothing you can see. Mixing them in
 * buried the row that actually explains a wrong size under rows that never
 * apply. Same rule `font-probe.ts` already follows.
 */
const IS_AGENT_WINDOW =
  typeof window !== "undefined" && window.location.pathname === "/agent-window";

const appliesHere = (scope: "agent" | "ide" | "both"): boolean =>
  scope === "both" || (IS_AGENT_WINDOW ? scope === "agent" : scope === "ide");

const TEXT_TARGETS: TextTarget[] = [
  // Agent rows lead: this is the product surface, so it is what the panel
  // should answer for first.
  {
    key: "message",
    label: "Message text",
    hint: ".agw-md",
    window: "agent",
    find: () => document.querySelector(".agw-md"),
  },
  {
    key: "composer",
    label: "Composer",
    hint: ".agw-composer",
    window: "agent",
    find: () => document.querySelector(".agw-composer"),
  },
  {
    key: "agent",
    label: "Window shell",
    hint: ".agw-root",
    window: "agent",
    find: () => document.querySelector(".agw-root"),
  },
  // Kept in BOTH windows, small: it is the host document, and it is the row
  // that caught the real startup face swap (fallback → Inter) — which nothing
  // scoped to `.agw-root` would have seen.
  { key: "app", label: "Host document", hint: "body", window: "both", find: () => document.body },
];

/** CSS variables that decide the values above. Element they live on, then name. */
const WATCHED_VARS: Array<{
  label: string;
  scope: "root" | "agent";
  window: "agent" | "ide" | "both";
  name: string;
}> = [
  // The agent window has its OWN scale, and it multiplies every `--agw-fs-*`
  // step. Missing it is why a 16px message could not be explained from the log:
  // `.agw-md` falls back to `--agw-fs-md`, which is `calc(15px * this)`.
  { label: "text scale", scope: "agent", window: "agent", name: "--agw-ui-text-scale" },
  { label: "size step (md)", scope: "agent", window: "agent", name: "--agw-fs-md" },
  { label: "message size", scope: "agent", window: "agent", name: "--agw-msg-font-size" },
  { label: "message leading", scope: "agent", window: "agent", name: "--agw-msg-line-height" },
  { label: "message weight", scope: "agent", window: "agent", name: "--agw-msg-font-weight" },
  { label: "UI font", scope: "agent", window: "agent", name: "--agw-font-ui" },
  { label: "code font", scope: "agent", window: "agent", name: "--agw-font-code" },
  { label: "IDE text scale", scope: "root", window: "ide", name: "--aurora-ui-text-scale" },
  { label: "IDE font", scope: "root", window: "ide", name: "--aurora-ui-font-family" },
  { label: "IDE code font", scope: "root", window: "ide", name: "--aurora-code-font-family" },
];

// ── Measurement ──────────────────────────────────────────────────────────

/**
 * Sample string for the width reading. Mixed advance widths so two faces at the
 * same nominal size cannot coincidentally measure alike.
 */
const SAMPLE = "Handgloves 0123456789 mmiilWW";

let widthEl: HTMLSpanElement | null = null;

/** Offscreen span the width readings run through. Kept alive between samples. */
function widthProbe(): HTMLSpanElement | null {
  if (widthEl?.isConnected) return widthEl;
  if (!document.body) return null;
  const el = document.createElement("span");
  el.textContent = SAMPLE;
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
  el.style.cssText =
    "position:absolute;left:-99999px;top:-99999px;white-space:nowrap;pointer-events:none";
  document.body.appendChild(el);
  widthEl = el;
  return el;
}

/** One reading of an element's text metrics. All strings — they only get compared and printed. */
type Reading = Record<string, string>;

const px = (value: string): string => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}px` : value || "—";
};

function readTarget(el: Element): Reading {
  const cs = getComputedStyle(el);
  const reading: Reading = {
    size: px(cs.fontSize),
    line: cs.lineHeight === "normal" ? "normal" : px(cs.lineHeight),
    weight: cs.fontWeight || "—",
    // First family in the computed stack: what the CSS is ASKING for. Paired
    // with `width` below, which is what it actually GOT.
    asks: (cs.fontFamily.split(",")[0] ?? "").replace(/^["']|["']$/g, "").trim() || "—",
    width: "—",
  };

  const probe = widthProbe();
  if (probe) {
    // Copy the exact font description rather than the `font` shorthand, which
    // Chromium serializes as "" for multi-family stacks.
    probe.style.fontStyle = cs.fontStyle;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontStretch = cs.fontStretch;
    probe.style.fontVariant = cs.fontVariant;
    probe.style.letterSpacing = cs.letterSpacing;
    reading.width = `${probe.getBoundingClientRect().width.toFixed(2)}px`;
  }
  return reading;
}

/**
 * Compare-safe form of a value.
 *
 * Setting a font stack through CSSOM re-serializes it — single quotes become
 * double, newlines and runs of spaces collapse — so the identical stack read
 * back after an apply looked like a change and logged two entries at +20ms that
 * meant nothing. A recorder that reports cosmetic churn as a change is one you
 * stop believing, which is the whole point of it.
 */
function normalize(value: string): string {
  return value.replace(/['"]/g, '"').replace(/\s+/g, " ").trim();
}

function readVars(): Reading {
  const root = document.documentElement;
  const agent = document.querySelector(".agw-root");
  const out: Reading = {};
  for (const v of WATCHED_VARS) {
    if (!appliesHere(v.window)) continue;
    const el = v.scope === "agent" ? agent : root;
    // `.agw-root` mounts with React, well after the first reading. Report the
    // row as pending rather than omitting it: a key that simply appears later
    // never gets compared against anything, so the agent window's own
    // typography was silently missing from the whole log.
    if (!el) {
      out[v.label] = "(not mounted yet)";
      continue;
    }
    const value = getComputedStyle(el).getPropertyValue(v.name).trim();
    out[v.label] = value ? normalize(value) : "(unset — using the built-in default)";
  }
  return out;
}

function readFaces(): Reading {
  const out: Reading = {};
  try {
    for (const r of readFontState()) {
      // `--aurora-ui-font-family` is set on the root in BOTH windows, so the
      // probe reports an "IDE · UI" face here even though nothing in the agent
      // window is painted with it. Drop it rather than let a face that styles
      // nothing sit next to the ones that do.
      if (IS_AGENT_WINDOW && r.role.startsWith("IDE")) continue;
      out[r.role] = r.loaded ? r.using : `${r.using} (not loaded)`;
    }
  } catch {
    // The probe measures through layout; if it cannot, say so rather than
    // silently reporting an empty face set.
    out["(face probe failed)"] = "—";
  }
  return out;
}

// ── Change log ───────────────────────────────────────────────────────────

interface Change {
  at: number;
  group: string;
  field: string;
  from: string;
  to: string;
}

const MAX_CHANGES = 600;
const changes: Change[] = [];
let startedAt = 0;
let baseline: string[] = [];

/** Compare two readings and record every field that moved. */
function diff(group: string, before: Reading | null, after: Reading, at: number): boolean {
  if (!before) {
    // First sighting. Recorded as an arrival, not as a change — a row that
    // simply did not exist yet is not evidence of anything shifting.
    for (const [field, to] of Object.entries(after)) {
      baseline.push(`${group} · ${field} = ${to}`);
    }
    if (startedAt > 0 && at > 250) {
      changes.push({ at, group, field: "(appeared)", from: "—", to: "" });
    }
    return true;
  }
  let moved = false;
  for (const [field, to] of Object.entries(after)) {
    const from = before[field];
    // A field that only exists now is still news — it is how a late-mounting
    // surface's values enter the record at all.
    if (from === undefined) {
      baseline.push(`${group} · ${field} = ${to}`);
      continue;
    }
    if (from === to) continue;
    changes.push({ at, group, field, from, to });
    moved = true;
  }
  if (changes.length > MAX_CHANGES) changes.splice(0, changes.length - MAX_CHANGES);
  return moved;
}

// ── Panel ────────────────────────────────────────────────────────────────

/** Pinned so the panel cannot re-typeset itself alongside what it measures. */
const PANEL_FONT = 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace';
const INK = "#d8dee9";
const MUTED = "#7b8494";
const ACCENT = "#7fd1a8";
const MOVED = "#f0b072";

let panel: HTMLDivElement | null = null;
let liveEl: HTMLDivElement | null = null;
let logEl: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;
let copyBtn: HTMLButtonElement | null = null;

function row(label: string, hint: string, cells: string, highlight: boolean): string {
  return (
    `<div style="display:flex;gap:6px;align-items:baseline;padding:1px 0">` +
    `<span style="flex:0 0 96px;color:${highlight ? MOVED : INK}">${esc(label)}</span>` +
    `<span style="flex:1;color:${highlight ? MOVED : MUTED};word-break:break-all">${esc(cells)}</span>` +
    (hint ? `<span style="flex:0 0 auto;color:#4d5462">${esc(hint)}</span>` : "") +
    `</div>`
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function heading(text: string): string {
  return `<div style="color:${ACCENT};letter-spacing:.08em;margin:6px 0 2px">${esc(text)}</div>`;
}

function buildPanel(): void {
  if (panel?.isConnected || !document.body) return;

  panel = document.createElement("div");
  panel.setAttribute("data-typography-debug", "");
  panel.style.cssText = [
    "position:fixed",
    "right:10px",
    "bottom:10px",
    "z-index:2147483000",
    "width:392px",
    "max-height:46vh",
    "display:flex",
    "flex-direction:column",
    "background:#14161acc",
    "backdrop-filter:blur(8px)",
    "border:1px solid #2b3038",
    "border-radius:8px",
    "box-shadow:0 8px 28px #0009",
    `font-family:${PANEL_FONT}`,
    "font-size:11px",
    "line-height:1.5",
    `color:${INK}`,
    "overflow:hidden",
  ].join(";");

  const header = document.createElement("div");
  header.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:8px",
    "padding:6px 8px",
    "border-bottom:1px solid #2b3038",
    "flex:0 0 auto",
  ].join(";");
  header.innerHTML =
    `<span style="color:${ACCENT};font-weight:700;letter-spacing:.06em">TYPOGRAPHY</span>` +
    `<span data-count style="color:${MUTED}">watching…</span>`;

  copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy log";
  copyBtn.style.cssText = [
    "margin-left:auto",
    "font:inherit",
    `color:${INK}`,
    "background:#20242c",
    "border:1px solid #343b45",
    "border-radius:5px",
    "padding:2px 8px",
    "cursor:pointer",
  ].join(";");
  copyBtn.addEventListener("click", () => void copyAll());
  header.appendChild(copyBtn);

  // Dismiss. Stops the recorder AND clears the flag, so it does not come back
  // on the next reload — a debug panel you have to hunt for the off switch of
  // is one you end up shipping by accident.
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Turn off (auroraTypographyDebug.on() to bring it back)";
  closeBtn.setAttribute("aria-label", "Turn off the typography recorder");
  closeBtn.style.cssText = [
    "font:inherit",
    `color:${MUTED}`,
    "background:transparent",
    "border:1px solid #343b45",
    "border-radius:5px",
    "padding:2px 7px",
    "cursor:pointer",
  ].join(";");
  closeBtn.addEventListener("click", () => {
    try {
      localStorage.removeItem(DEBUG_KEY);
    } catch {
      // Nothing persisted means nothing to clear — stopping is still correct.
    }
    stopTypographyDebug();
  });
  header.appendChild(closeBtn);

  liveEl = document.createElement("div");
  liveEl.style.cssText = "padding:6px 8px;flex:0 0 auto;border-bottom:1px solid #2b3038";

  logEl = document.createElement("div");
  logEl.style.cssText = "padding:6px 8px;overflow:auto;flex:1 1 auto";

  panel.append(header, liveEl, logEl);
  document.body.appendChild(panel);
  countEl = header.querySelector("[data-count]");
}

/** Fields whose value moved in the last 1.5s — surfaced by color, not motion. */
const recentlyMoved = new Map<string, number>();

function renderLive(groups: Array<{ name: string; hint: string; reading: Reading }>): void {
  if (!liveEl) return;
  const now = performance.now();
  let html = "";
  for (const g of groups) {
    html += heading(g.name);
    for (const [field, value] of Object.entries(g.reading)) {
      const stamp = recentlyMoved.get(`${g.name}·${field}`);
      html += row(field, g.hint, value, stamp !== undefined && now - stamp < 1500);
    }
  }
  liveEl.innerHTML = html;
}

function renderLog(): void {
  if (!logEl || !countEl) return;
  countEl.textContent =
    changes.length === 0
      ? `no changes yet · ${Math.round(performance.now() - startedAt)}ms`
      : `${changes.length} change${changes.length === 1 ? "" : "s"}`;

  if (changes.length === 0) {
    // Designed absence: "nothing has moved" is the good outcome and a real
    // answer, so it is stated rather than left as an empty box.
    logEl.innerHTML =
      `<div style="color:${MUTED};padding:4px 0">Nothing has changed since the window opened.` +
      ` If the text looked like it shifted, it did not — at least not in size, weight, leading,` +
      ` face or rendered width.</div>`;
    return;
  }
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  logEl.innerHTML = changes.map(logLine).join("");
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function logLine(c: Change): string {
  const time = `+${Math.round(c.at)}ms`.padStart(8, " ");
  const arrow = c.field === "(appeared)" ? "" : ` <span style="color:${MUTED}">${esc(c.from)}</span> → <span style="color:${MOVED}">${esc(c.to)}</span>`;
  return (
    `<div style="padding:1px 0;white-space:pre-wrap">` +
    `<span style="color:#4d5462">${esc(time)}</span>  ` +
    `<span style="color:${INK}">${esc(c.group)}</span>` +
    `<span style="color:${MUTED}"> · ${esc(c.field)}</span>${arrow}</div>`
  );
}

// ── Copy ─────────────────────────────────────────────────────────────────

function logAsText(): string {
  const lines = [
    "Aurora typography change log",
    `window      ${IS_AGENT_WINDOW ? "agent" : "IDE"}`,
    `origin      ${location.origin}${location.pathname}`,
    `recorded    ${Math.round(performance.now() - startedAt)}ms since boot`,
    `dpr         ${window.devicePixelRatio}`,
    "",
    "── baseline (first reading) ──",
    ...baseline,
    "",
    `── changes (${changes.length}) ──`,
  ];
  if (changes.length === 0) {
    lines.push("none — nothing changed after the first reading");
  } else {
    for (const c of changes) {
      lines.push(
        c.field === "(appeared)"
          ? `+${Math.round(c.at)}ms  ${c.group} appeared`
          : `+${Math.round(c.at)}ms  ${c.group} · ${c.field}  ${c.from} → ${c.to}`,
      );
    }
  }
  return lines.join("\n");
}

async function copyAll(): Promise<void> {
  const text = logAsText();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Clipboard API can be refused; the textarea path works without permission.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch {
      ok = false;
    }
  }
  if (!copyBtn) return;
  // Every action gets a response — including the failing one, which must not
  // look like success.
  copyBtn.textContent = ok ? "Copied" : "Copy failed";
  copyBtn.style.color = ok ? ACCENT : "#e88";
  window.setTimeout(() => {
    if (!copyBtn) return;
    copyBtn.textContent = "Copy log";
    copyBtn.style.color = INK;
  }, 1400);
}

// ── Sampling ─────────────────────────────────────────────────────────────

const previous = new Map<string, Reading>();

/** Face resolution measures through layout — too heavy for every frame. */
const FACE_INTERVAL_MS = 500;
/** Frame-by-frame sampling window. The startup swap lands inside this. */
const BURST_MS = 4000;
/** Steady-state cadence once the burst is over. */
const IDLE_MS = 300;

let lastFaceAt = -Infinity;
let lastFaces: Reading = {};

function sample(): void {
  const at = performance.now() - startedAt;
  const groups: Array<{ name: string; hint: string; reading: Reading }> = [];

  for (const target of TEXT_TARGETS) {
    if (!appliesHere(target.window)) continue;
    const el = target.find();
    if (!el) continue;
    const reading = readTarget(el);
    if (diff(target.label, previous.get(target.key) ?? null, reading, at)) {
      for (const field of Object.keys(reading)) {
        if (previous.get(target.key)?.[field] !== reading[field]) {
          recentlyMoved.set(`${target.label}·${field}`, performance.now());
        }
      }
    }
    previous.set(target.key, reading);
    groups.push({ name: target.label, hint: target.hint, reading });
  }

  const vars = readVars();
  diff("Setting", previous.get("vars") ?? null, vars, at);
  previous.set("vars", vars);

  const now = performance.now();
  if (now - lastFaceAt >= FACE_INTERVAL_MS) {
    lastFaceAt = now;
    lastFaces = readFaces();
    diff("Face", previous.get("faces") ?? null, lastFaces, at);
    previous.set("faces", lastFaces);
  }

  groups.push({ name: "Settings", hint: "", reading: vars });
  groups.push({ name: "Faces", hint: "", reading: lastFaces });

  buildPanel();
  renderLive(groups);
  renderLog();
}

let rafId = 0;
let timer = 0;
let stopped = false;

/**
 * Begin recording. Call as early as possible — the whole point is to be running
 * before the first paint. Idempotent, so an HMR re-run of the entry module
 * replaces the recorder instead of stacking a second one.
 */
export function startTypographyDebug(): () => void {
  stopTypographyDebug();
  stopped = false;
  startedAt = performance.now();
  baseline = [];
  changes.length = 0;
  previous.clear();

  // Synchronous first reading, before anything else in the entry module runs.
  // A rAF-scheduled baseline would already contain the boot-time apply, and the
  // very change this exists to catch would be invisible.
  sample();

  const burst = (): void => {
    if (stopped) return;
    sample();
    if (performance.now() - startedAt < BURST_MS) {
      rafId = requestAnimationFrame(burst);
    } else {
      timer = window.setInterval(() => {
        if (!stopped) sample();
      }, IDLE_MS);
    }
  };
  rafId = requestAnimationFrame(burst);

  // A face finishing its load is the classic late swap — sample immediately
  // rather than waiting up to 300ms for the next tick to notice.
  document.fonts?.addEventListener?.("loadingdone", sample);

  return stopTypographyDebug;
}

/** localStorage flag that survives a reload — see `initTypographyDebug`. */
const DEBUG_KEY = "aurora-typography-debug";

interface TypographyDebugApi {
  on: () => string;
  off: () => string;
  log: () => string;
}

/**
 * Boot entry. Installs the console API always (it is three closures) and starts
 * the recorder ONLY when it was switched on. Call as early as possible in the
 * entry module — when the flag is set, recording has to begin before the first
 * paint or the startup window is already gone.
 */
export function initTypographyDebug(): void {
  let enabled = false;
  try {
    enabled = localStorage.getItem(DEBUG_KEY) === "on";
  } catch {
    // No storage access — stay off. The console API below still works for a
    // one-session run.
  }

  const api: TypographyDebugApi = {
    on: () => {
      try {
        localStorage.setItem(DEBUG_KEY, "on");
      } catch {
        // Session-only is still useful; say so rather than claim persistence.
      }
      startTypographyDebug();
      return "Typography recorder on. Reload to capture the startup window — that is the part worth having.";
    },
    off: () => {
      try {
        localStorage.removeItem(DEBUG_KEY);
      } catch {
        // Already unreachable storage means nothing is persisted to clear.
      }
      stopTypographyDebug();
      return "Typography recorder off.";
    },
    log: () => {
      const text = logAsText();
      console.log(text);
      return text;
    },
  };
  (window as unknown as { auroraTypographyDebug?: TypographyDebugApi }).auroraTypographyDebug = api;

  if (enabled) startTypographyDebug();
}

export function stopTypographyDebug(): void {
  stopped = true;
  if (rafId) cancelAnimationFrame(rafId);
  if (timer) window.clearInterval(timer);
  rafId = 0;
  timer = 0;
  document.fonts?.removeEventListener?.("loadingdone", sample);
  panel?.remove();
  panel = null;
  widthEl?.remove();
  widthEl = null;
}
