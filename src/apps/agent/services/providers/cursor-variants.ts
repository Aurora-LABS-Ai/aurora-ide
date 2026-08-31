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
 * A model with no `-fast` twin must not be sent `-fast`: that id fails at
 * request time. Unsupported combinations fail before a turn starts instead of
 * silently changing an effort, thinking mode, or speed choice.
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

interface IndexedCursorVariant {
  modelId: string;
  parts: CursorVariantParts;
}

/**
 * Every real id the account carries, keyed by stable stem.
 *
 * The value keeps parsed parts instead of just an id set. Cursor writes
 * modifiers in more than one order, so composing a preferred order and looking
 * for that spelling can miss a real variant. Resolution compares the semantic
 * tuple and returns the exact id Cursor supplied.
 */
let index = new Map<string, IndexedCursorVariant[]>();

/**
 * Where the id list is mirrored so the index can outlive the module.
 *
 * Module-level state does not survive a Vite HMR update — a change to this
 * file re-evaluates it and `index` comes back empty — and nothing re-primes it
 * until the next catalogue sync, which only runs at window start-up. So during
 * development the index could sit empty for an entire session, and every turn
 * in that window composed an id it could not confirm.
 *
 * The same gap exists in production, just narrower: between the window opening
 * and the first sync completing. Mirroring the list makes the index available
 * immediately in both cases, from the last catalogue the account reported.
 */
const VARIANT_IDS_KEY = "agw:cursor-variant-ids";

/** Replace the index with what the account currently carries. */
export function primeCursorVariants(models: CursorModelView[]): void {
  index = buildIndex(models.map((model) => model.modelId));
  hydrated = true;
  try {
    localStorage.setItem(
      VARIANT_IDS_KEY,
      JSON.stringify(models.map((model) => model.modelId)),
    );
  } catch {
    // Storage blocked or full. The in-memory index still holds for this
    // session, which is the case that matters most.
  }
}

/**
 * Whether the mirror has been consulted yet.
 *
 * Distinct from "the index is empty": an account with no models is a real
 * state, and re-reading storage on every lookup for it would be waste.
 */
let hydrated = false;

/** Forget the catalogue — on disconnect, so a stale index can't outlive it. */
export function clearCursorVariants(): void {
  index = new Map();
  // Deliberately marked hydrated: disconnecting means "there is no catalogue",
  // and re-reading the mirror would resurrect the one just discarded.
  hydrated = true;
  try {
    localStorage.removeItem(VARIANT_IDS_KEY);
  } catch {
    // Nothing to do — the in-memory index is already empty.
  }
}

/** Test seam. */
export function cursorVariantIndexSize(): number {
  ensureHydrated();
  return index.size;
}

/** Test seam: forget memory so the next read must hydrate from the mirror. */
export function resetCursorVariantHydration(): void {
  index = new Map();
  hydrated = false;
}

function buildIndex(modelIds: Iterable<string>): Map<string, IndexedCursorVariant[]> {
  const next = new Map<string, IndexedCursorVariant[]>();
  for (const modelId of modelIds) {
    const parts = splitCursorVariant(modelId);
    const variant = { modelId, parts };
    const bucket = next.get(parts.stem);
    if (bucket) bucket.push(variant);
    else next.set(parts.stem, [variant]);
  }
  return next;
}

function ensureHydrated(): void {
  if (!hydrated) hydrateFromMirror();
}

/** Rebuild the index from the last catalogue this browser saw. */
function hydrateFromMirror(): void {
  hydrated = true;
  try {
    const raw = localStorage.getItem(VARIANT_IDS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    index = buildIndex(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    // A corrupt mirror is the same as no catalogue. Resolution fails closed
    // until the normal account sync primes a fresh one.
  }
}

// ── Composition ──────────────────────────────────────────────────────────────

export interface CursorRunOptions {
  /** Whether the exact run must use a thinking variant. */
  thinking?: boolean;
  /** Effort tier. `null` for models whose ids carry none. */
  effort?: CursorEffort | string | null;
  /** Whether the exact run must use Cursor's Fast lane. */
  fast?: boolean;
}

export interface CursorVariantCapabilities {
  stem: string;
  efforts: CursorEffort[];
  hasThinking: boolean;
  thinkingOnly: boolean;
  hasFast: boolean;
}

/** Capability summary from the same exact variants used for send resolution. */
export function cursorVariantCapabilities(picked: string): CursorVariantCapabilities | null {
  ensureHydrated();
  const { stem } = splitCursorVariant(picked);
  const variants = index.get(stem);
  if (!variants?.length) return null;
  const efforts = CURSOR_EFFORTS.filter((effort) =>
    variants.some((variant) => variant.parts.effort === effort),
  );
  const hasThinking = variants.some((variant) => variant.parts.thinking);
  return {
    stem,
    efforts,
    hasThinking,
    thinkingOnly: hasThinking && variants.every((variant) => variant.parts.thinking),
    hasFast: variants.some((variant) => variant.parts.fast),
  };
}

export type CursorVariantFailureReason =
  | "catalogue_unavailable"
  | "unknown_model"
  | "unsupported_combination";

export type CursorVariantResolution =
  | {
      ok: true;
      stem: string;
      wireModel: string;
      run: CursorVariantParts;
    }
  | {
      ok: false;
      stem: string;
      reason: CursorVariantFailureReason;
      requested: CursorVariantParts;
    };

function sameRun(
  parts: CursorVariantParts,
  requested: Pick<CursorVariantParts, "thinking" | "effort" | "fast">,
): boolean {
  return (
    parts.thinking === requested.thinking &&
    parts.effort === requested.effort &&
    parts.fast === requested.fast
  );
}

/** Resolve exactly one account-backed wire id. No guessing and no downgrades. */
export function resolveCursorVariant(
  picked: string,
  options: CursorRunOptions = {},
): CursorVariantResolution {
  ensureHydrated();
  const own = splitCursorVariant(picked);
  const { stem } = own;
  const requested: CursorVariantParts = {
    stem,
    thinking: options.thinking ?? own.thinking,
    effort: (options.effort === undefined ? own.effort : options.effort) as CursorEffort | null,
    fast: options.fast ?? own.fast,
  };
  const variants = index.get(stem);
  if (!variants?.length) {
    return {
      ok: false,
      stem,
      reason: index.size === 0 ? "catalogue_unavailable" : "unknown_model",
      requested,
    };
  }
  const match = variants.find((variant) => sameRun(variant.parts, requested));
  if (!match) {
    return { ok: false, stem, reason: "unsupported_combination", requested };
  }
  return { ok: true, stem, wireModel: match.modelId, run: match.parts };
}

/**
 * Convenience for request builders that need a string. Errors contain a calm,
 * recoverable message suitable for a provider test or chat failure card.
 */
export function cursorWireModel(picked: string, options: CursorRunOptions = {}): string {
  const resolved = resolveCursorVariant(picked, options);
  if (resolved.ok) return resolved.wireModel;
  throw new Error(cursorVariantFailureMessage(resolved));
}

export function cursorVariantFailureMessage(
  failure: Extract<CursorVariantResolution, { ok: false }>,
): string {
  if (failure.reason === "catalogue_unavailable") {
    return "Cursor's model catalogue is not ready. Reload Cursor models in Settings, then try again.";
  }
  if (failure.reason === "unknown_model") {
    return `Cursor no longer offers ${failure.stem}. Reload its model catalogue and choose an available model.`;
  }
  const choices = [
    failure.requested.thinking ? "thinking" : null,
    failure.requested.effort ? `${failure.requested.effort} effort` : null,
    failure.requested.fast ? "Fast" : null,
  ].filter((choice): choice is string => choice !== null);
  const run = choices.length > 0 ? choices.join(", ") : "the selected settings";
  return `Cursor does not offer ${failure.stem} with ${run}. Change the model settings and try again.`;
}

/** Whether Fast exists for this exact thinking and effort combination. */
export function cursorHasFast(
  picked: string,
  options: Omit<CursorRunOptions, "fast"> = {},
): boolean {
  return resolveCursorVariant(picked, { ...options, fast: true }).ok;
}

// ── Grouping a catalogue into pickable models ────────────────────────────────

/** One real model, and every way the account can run it. */
export interface CursorRunnableModel {
  stem: string;
  /** models.dev key — `grok-4.6`. `null` for `auto`. */
  catalogKey: string | null;
  label: string;
  /** Real raw id used to choose the row's initial effort and thinking defaults. */
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
/**
 * Whether this model reasons at all.
 *
 * Cursor says so in two ways, and only one of them uses the word. A model with
 * `-thinking` ids obviously reasons — but so does one whose ids are
 * `-low`/`-medium`/`-high`/`-xhigh`, because on this wire an effort tier IS the
 * reasoning control; there is no separate field for it. Reading only the first
 * left Grok, four tiers deep, marked as a model that does not think, sitting
 * directly beneath a Claude row that does.
 *
 * `none` is a real tier meaning reasoning off, so a model offering only that
 * one is not a reasoning model.
 */
export function cursorReasons(
  model: Pick<CursorRunnableModel, "hasThinking" | "efforts">,
): boolean {
  return model.hasThinking || model.efforts.some((tier) => tier !== "none");
}

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
