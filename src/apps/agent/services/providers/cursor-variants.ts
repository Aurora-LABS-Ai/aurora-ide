/**
 * Cursor model ids — taking them apart and putting them back together.
 *
 * ## Why this exists
 *
 * A Cursor account reaches ~200 model ids, and **there is no plain one**.
 * `cursor-grok-4.6` does not exist: the account carries
 * `cursor-grok-4.6-low`, `-medium`, `-high`, `-xhigh`, and a `-fast` twin of
 * each. Effort is not a parameter you send alongside the model — it is part
 * of the model id. Same for thinking (`cursor-claude-opus-5-thinking-high`)
 * and for Fast.
 *
 * That is the opposite of every other provider Aurora talks to, where
 * `reasoning_effort` rides in the request body. So the picker cannot show one
 * row per id (204 rows), and it cannot show one row per model with a
 * `reasoning_effort` control either (the field goes nowhere — Cursor's wire
 * has no such thing).
 *
 * What it can do is show one row per model and **recompose the id at send
 * time** from the controls the user actually touched. That is this module:
 * split an id into its parts, and build one back out of a stem plus the
 * thinking / effort / fast the turn wants.
 *
 * Composition is checked against the account's real catalogue, never assumed.
 * A model with no `-fast` twin must not be sent `-fast` — that id 404s at
 * request time, which surfaces to the user as a failed turn with no
 * explanation. {@link cursorWireModel} degrades through what exists instead.
 */

import type { CursorModelView } from "./cursor";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Effort tiers, weakest to strongest. Order is the display order in the
 * picker, so it must read as a ramp rather than as whatever order the account
 * happened to list.
 *
 * `none` is a real tier on some models (reasoning off, same model) and is kept
 * rather than dropped: hiding it would remove the only way to run those models
 * without reasoning.
 */
export const CURSOR_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra",
  "max",
] as const;

export type CursorEffort = (typeof CURSOR_EFFORTS)[number];

const THINKING = "thinking";
const FAST = "fast";

/**
 * Every trailing token that describes *how* to run a model rather than *which*
 * model it is. Longest-first so `-xhigh` is never left as a stray `-x` by an
 * earlier match on `high`.
 */
const MODIFIERS = [THINKING, "minimal", "medium", "xhigh", "extra", "high", "none", FAST, "low", "max"]
  .slice()
  .sort((a, b) => b.length - a.length);

// ── Splitting ────────────────────────────────────────────────────────────────

export interface CursorVariantParts {
  /**
   * The id with every modifier stripped — `cursor-grok-4.6`. Keeps the
   * original prefix and casing, because this is what gets sent back on the
   * wire; `catalogKey` (lowercased, `cursor-` removed) is for models.dev and
   * is not interchangeable with it.
   */
  stem: string;
  thinking: boolean;
  effort: CursorEffort | null;
  fast: boolean;
}

/**
 * Split a Cursor id into the model and the way it is being run.
 *
 * Strips in a **loop** rather than in a fixed order: Cursor writes the same
 * pair both ways round — `claude-opus-5-thinking-high` and
 * `claude-4.5-opus-high-thinking` — so a single ordered pass leaves half of
 * them partly decorated and splits one model across two rows.
 */
export function splitCursorVariant(modelId: string): CursorVariantParts {
  let stem = modelId;
  let thinking = false;
  let fast = false;
  let effort: CursorEffort | null = null;

  for (;;) {
    const before = stem.length;
    for (const modifier of MODIFIERS) {
      const suffix = `-${modifier}`;
      if (!stem.toLowerCase().endsWith(suffix)) continue;
      stem = stem.slice(0, -suffix.length);
      if (modifier === THINKING) thinking = true;
      else if (modifier === FAST) fast = true;
      // Keep the FIRST effort seen, which — stripping right to left — is the
      // outermost one. An id carrying two is malformed either way; taking one
      // deterministically beats taking whichever came last.
      else if (!effort) effort = modifier as CursorEffort;
      break;
    }
    if (stem.length === before) break;
  }

  return { stem, thinking, effort, fast };
}

/** Build an id from its parts. The token order Cursor itself writes. */
export function composeCursorVariant(
  stem: string,
  parts: { thinking?: boolean; effort?: CursorEffort | string | null; fast?: boolean },
): string {
  let id = stem;
  if (parts.thinking) id += `-${THINKING}`;
  if (parts.effort) id += `-${parts.effort}`;
  if (parts.fast) id += `-${FAST}`;
  return id;
}

// ── The account's real catalogue ─────────────────────────────────────────────

/**
 * Which ids the account actually carries, keyed by stem.
 *
 * Module-level rather than React state because {@link cursorWireModel} is
 * called from the send path, which is not a component and must stay
 * synchronous — an `await` there would put an IPC round-trip in front of every
 * turn and force two more call sites to become async.
 *
 * Empty until {@link primeCursorVariants} runs. An empty index is not an error
 * state: composition falls back to the id the user picked, which is always a
 * real one because it came from this same catalogue.
 */
let index = new Map<string, Set<string>>();

/** Replace the index with what the account currently carries. */
export function primeCursorVariants(models: CursorModelView[]): void {
  const next = new Map<string, Set<string>>();
  for (const model of models) {
    const { stem } = splitCursorVariant(model.modelId);
    const bucket = next.get(stem);
    if (bucket) bucket.add(model.modelId);
    else next.set(stem, new Set([model.modelId]));
  }
  index = next;
}

/** Forget the catalogue — on disconnect, so a stale index can't outlive it. */
export function clearCursorVariants(): void {
  index = new Map();
}

/** Test seam. */
export function cursorVariantIndexSize(): number {
  return index.size;
}

function exists(stem: string, id: string): boolean {
  return index.get(stem)?.has(id) ?? false;
}

// ── Composition ──────────────────────────────────────────────────────────────

export interface CursorRunOptions {
  /** Insert `-thinking`. Ignored when the model has no thinking variant. */
  thinking?: boolean;
  /** Effort tier. `null` for models whose ids carry none. */
  effort?: CursorEffort | string | null;
  /** Append `-fast`. Ignored when the model has no fast twin. */
  fast?: boolean;
}

/**
 * The id to actually send for a picked model run a particular way.
 *
 * `picked` is a real id from the catalogue (it is what the model row stores),
 * so its own parts are the fallback for anything asked for that does not
 * exist. The chain gives up one request at a time, weakest wish first:
 *
 *   1. exactly what was asked for
 *   2. …without Fast (a model with no fast twin still runs, just not fast)
 *   3. …falling back to the effort the picked id already carries
 *   4. …without thinking
 *   5. the picked id, untouched
 *
 * Never invents an id: every step but the last is checked against the account.
 */
export function cursorWireModel(picked: string, options: CursorRunOptions = {}): string {
  const own = splitCursorVariant(picked);
  const { stem } = own;

  const thinking = options.thinking ?? own.thinking;
  const effort = options.effort === undefined ? own.effort : options.effort;
  const fast = options.fast ?? own.fast;

  const attempts: Array<{ thinking: boolean; effort: CursorEffort | string | null; fast: boolean }> = [
    { thinking, effort, fast },
    { thinking, effort, fast: false },
    { thinking, effort: own.effort, fast },
    { thinking, effort: own.effort, fast: false },
    { thinking: false, effort, fast },
    { thinking: false, effort: own.effort, fast: false },
  ];

  for (const attempt of attempts) {
    const candidate = composeCursorVariant(stem, attempt);
    if (exists(stem, candidate)) return candidate;
  }
  return picked;
}

/** Whether this model has a `-fast` twin — what greys out the Fast control. */
export function cursorHasFast(picked: string, options: CursorRunOptions = {}): boolean {
  const own = splitCursorVariant(picked);
  const thinking = options.thinking ?? own.thinking;
  const effort = options.effort === undefined ? own.effort : options.effort;
  return (
    exists(own.stem, composeCursorVariant(own.stem, { thinking, effort, fast: true })) ||
    exists(own.stem, composeCursorVariant(own.stem, { ...own, fast: true }))
  );
}

// ── Grouping a catalogue into pickable models ────────────────────────────────

/** One real model, and every way the account can run it. */
export interface CursorRunnableModel {
  stem: string;
  /** models.dev key — `grok-4.6`. `null` for `auto`. */
  catalogKey: string | null;
  label: string;
  /** The id the model row stores: preferred effort, no fast, no thinking. */
  representativeId: string;
  /** Every id under this model — what a bulk enable/disable writes. */
  variantIds: string[];
  /** Effort tiers this model offers, weak to strong. Empty when it has none. */
  efforts: CursorEffort[];
  /** Whether `-thinking` ids exist. */
  hasThinking: boolean;
  /** Whether **only** `-thinking` ids exist — reasoning that can't be switched off. */
  thinkingOnly: boolean;
  hasFast: boolean;
  /** Offered in the model picker. True when any id under it is switched on. */
  enabled: boolean;
  isLegacy: boolean;
  sortOrder: number;
}

/**
 * Effort preferred as a model's default when the account offers a choice.
 *
 * `high` rather than the maximum: `xhigh`/`max` cost real time on every turn,
 * and picking the most expensive tier on the user's behalf is not a default,
 * it is a decision. The tier is one click away in the picker.
 */
const PREFERRED_EFFORTS: CursorEffort[] = ["high", "medium", "xhigh", "low", "max", "extra", "minimal", "none"];

/**
 * Collapse a flat catalogue into the models a picker should offer.
 *
 * Grouping is by **stem**, not by `catalogKey`: the stem is what an id can be
 * rebuilt from, and two models that reduce to the same models.dev key while
 * carrying different prefixes must not be merged into a row that can only
 * address one of them.
 */
export function toRunnableModels(models: CursorModelView[]): CursorRunnableModel[] {
  const byStem = new Map<string, { parts: CursorVariantParts; view: CursorModelView }[]>();

  for (const view of models) {
    const parts = splitCursorVariant(view.modelId);
    const bucket = byStem.get(parts.stem);
    if (bucket) bucket.push({ parts, view });
    else byStem.set(parts.stem, [{ parts, view }]);
  }

  const out: CursorRunnableModel[] = [];

  for (const [stem, entries] of byStem) {
    const efforts = CURSOR_EFFORTS.filter((tier) =>
      entries.some((e) => e.parts.effort === tier),
    );
    const hasThinking = entries.some((e) => e.parts.thinking);
    const thinkingOnly = hasThinking && entries.every((e) => e.parts.thinking);
    const hasFast = entries.some((e) => e.parts.fast);

    // The row's identity. Non-fast so Fast stays a per-turn choice; non-thinking
    // where the account allows it, so the reasoning switch has an off position
    // that maps to a real id.
    const preferredEffort =
      PREFERRED_EFFORTS.find((tier) => efforts.includes(tier)) ?? efforts[0] ?? null;
    const representative =
      entries.find(
        (e) =>
          !e.parts.fast &&
          e.parts.thinking === thinkingOnly &&
          e.parts.effort === preferredEffort,
      ) ??
      entries.find((e) => !e.parts.fast) ??
      entries[0];

    out.push({
      stem,
      catalogKey: representative.view.catalogKey,
      label: labelFor(representative.view, stem),
      representativeId: representative.view.modelId,
      variantIds: entries.map((e) => e.view.modelId),
      efforts: [...efforts],
      hasThinking,
      thinkingOnly,
      hasFast,
      enabled: entries.some((e) => e.view.enabled),
      // A model is only an older generation if every id under it is.
      isLegacy: entries.every((e) => e.view.isLegacy),
      sortOrder: Math.min(...entries.map((e) => e.view.sortOrder)),
    });
  }

  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Model families Cursor now ships under its own name.
 *
 * Grok is Cursor's model, so the picker calls it Cursor Grok — the same name
 * the user would say out loud. Sitting in a list beside Claude and GPT rows
 * from other providers, a bare "Grok 4.6" would read as a third party's model
 * that happens to be reachable here.
 *
 * Prefixing is a display rule only: the id on the wire is untouched.
 */
const HOUSE_FAMILIES: Array<{ match: RegExp; prefix: string }> = [
  { match: /^grok\b/i, prefix: "Cursor" },
];

function withHousePrefix(label: string): string {
  for (const { match, prefix } of HOUSE_FAMILIES) {
    if (match.test(label) && !label.toLowerCase().startsWith(prefix.toLowerCase())) {
      return `${prefix} ${label}`;
    }
  }
  return label;
}

/**
 * A name for the row.
 *
 * Cursor's `displayName` describes one *variant* — "Grok 4.6 High Fast" — so
 * using it verbatim would name the row after whichever id happened to be
 * representative, and the name would change when the user changed the effort.
 * The modifiers are stripped off it; the stem is the fallback.
 */
function labelFor(view: CursorModelView, stem: string): string {
  const raw = view.displayName?.trim();
  if (raw) {
    const trimmed = stripDisplayModifiers(raw);
    if (trimmed) return withHousePrefix(trimmed);
  }
  const bare = stem.replace(/^cursor-/i, "");
  if (!bare || bare === "default") return "Auto";
  return withHousePrefix(
    bare
      .split("-")
      .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
      .join(" "),
  );
}

const DISPLAY_MODIFIERS = new Set([...MODIFIERS.map((m) => m.toLowerCase()), "xhigh", "x-high"]);

function stripDisplayModifiers(name: string): string {
  const words = name.split(/\s+/);
  while (words.length > 1 && DISPLAY_MODIFIERS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.join(" ");
}
