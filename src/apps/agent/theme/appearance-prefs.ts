/**
 * Agent Window — the appearance PREFERENCE table (theme concern, pure).
 *
 * Everything the Appearance page changes that is NOT a colour/type token lives
 * here, once, as a declarative table. Four things read it and none of them
 * keeps its own copy:
 *
 *   1. `useAgentThemeStore` initial state       (the defaults)
 *   2. `useAgentThemeStore.partialize`          (what persists)
 *   3. `resetCustomizations` + `hasAppearanceChanges` (the `reset` flag)
 *   4. export / import JSON                     (the `exported` flag)
 *
 * ## Why a table and not four lists
 *
 * Export used to write `{ id, name, appearance, tokens }` and import used to
 * apply tokens only. Every switch, slider and segmented control on the page —
 * Classic/V2, contrast, translucent sidebar, reduce motion, glide and its
 * speed, syntax highlighting — was silently dropped, so "export my look, import
 * it somewhere else" did not reproduce the look. Nothing failed; the fields
 * just were not in anyone's list.
 *
 * A hand-written list guards the list, never the class (see
 * `.knowledge/lesson.md`). With one table, adding a preference to the store
 * without classifying it here is a type error at the store's initial state, and
 * a test asserts every store setter has a row. A new preference cannot be
 * quietly left out of the export — it has to be given a reason.
 *
 * ## The two flags
 *
 * `exported` — does this travel in the JSON? True for everything that changes
 *   how the window LOOKS. The one false is the command-center chord: a theme
 *   file silently rebinding someone's keyboard is a hazard, not a look.
 *
 * `reset` — does "Reset appearance" clear it? True for what the Appearance page
 *   itself owns, plus the transcript switches (the first two were cleared by the
 *   reset before this table existed; later ones follow them). False for the two Preferences-page
 *   fields it never touched, so that button keeps doing exactly what it did.
 */

/** Which generation of the window's design is drawn. See `01-root.css`. */
export type AgentUiVersion = "classic" | "v2";

/** Where the composer's model selector sits. */
export type ModelSelectorPosition = "top" | "bottom";

/**
 * How the 48px icon rail is set apart from the sidebar beside it. Both paint
 * the frame colour, so with nothing between them they read as one slab.
 *
 * `line`  — a 1px border on the rail's right edge (the default).
 * `shade` — the rail and titlebar step toward the sheet colour, so the sidebar
 *   reads as a panel between the rail and the content. No line.
 * `none`  — one continuous frame, as before this setting existed.
 *
 * Probe: Documents/aurora-icon-rail-separation-designs.html.
 */
export type RailEdge = "line" | "shade" | "none";

/**
 * How the model's reasoning shows in a reply.
 *
 * `live` — open while the model is thinking, folded once it settles (the
 *   shipped behaviour).
 * `folded` — always folded to its "Thought 12s" header; click to read.
 * `hidden` — not drawn at all. The turn label still shimmers while the model
 *   works, so hiding the text never hides that something is happening.
 */
export type TranscriptReasoning = "live" | "folded" | "hidden";

/**
 * How streamed reply text is let out onto the screen.
 *
 * `eased` — closes a fixed share of the remaining gap every frame (the
 *   shipped behaviour). A burst shows as a quick surge that slows to a crawl.
 * `steady` — plays the stream back a fifth of a second late at the rate it
 *   actually arrived, so a burst is spread over the pause before it and the
 *   text moves at one even speed.
 * `instant` — every token is drawn the frame it lands.
 */
export type TranscriptTextPace = "eased" | "steady" | "instant";

/** Rail/dock glide duration when glide is on. */
export const DEFAULT_RAIL_GLIDE_MS = 580;

/** Neutral contrast — no adjustment. */
export const DEFAULT_CONTRAST = 50;

/**
 * How a value is validated when it arrives from a JSON file. Imported values
 * are UNTRUSTED: a hand-edited file, an older Aurora build, or a theme written
 * for a different app. A value that fails its check is skipped and the current
 * setting is kept, never coerced into something that renders broken.
 */
type PrefSpec<T> = {
  readonly default: T;
  /** Travels in the exported JSON. */
  readonly exported: boolean;
  /** Cleared by "Reset appearance". */
  readonly reset: boolean;
  /** Why, when a flag above is false. Required then, so the choice is stated. */
  readonly note?: string;
  /** Narrow an unknown JSON value to T, or null to skip it. */
  readonly parse: (raw: unknown) => T | null;
};

const bool = (raw: unknown): boolean | null =>
  typeof raw === "boolean" ? raw : null;

const str = (raw: unknown): string | null =>
  typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? raw : null;

/** Whole number inside [min, max]. Out-of-range CLAMPS rather than skipping —
 *  a 4000ms glide from a future build is a real intent we can honour at our
 *  ceiling, unlike a boolean that arrived as a string. */
const intIn =
  (min: number, max: number) =>
  (raw: unknown): number | null => {
    const n = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.round(n)));
  };

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (raw: unknown): T | null =>
    typeof raw === "string" && (values as readonly string[]).includes(raw)
      ? (raw as T)
      : null;

export const APPEARANCE_PREFS = {
  /** Frosted, semi-transparent left rail and dock. */
  translucentSidebar: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** How the icon rail is set apart from the sidebar. See `RailEdge`. */
  railEdge: {
    default: "line",
    exported: true,
    reset: true,
    parse: oneOf(["line", "shade", "none"] as const),
  } satisfies PrefSpec<RailEdge>,

  /** Which design generation the window draws. Composes with every theme. */
  uiVersion: {
    default: "classic",
    exported: true,
    reset: true,
    parse: oneOf(["classic", "v2"] as const),
  } satisfies PrefSpec<AgentUiVersion>,

  /** 0–100, 50 = neutral. Scales foreground/line separation. */
  contrast: {
    default: DEFAULT_CONTRAST,
    exported: true,
    reset: true,
    parse: intIn(0, 100),
  } satisfies PrefSpec<number>,

  /** Honour reduced motion (disables non-essential animation). */
  reduceMotion: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Syntax-highlight code in tool cards, the file viewer and message code
   *  blocks. When off, code renders in a single foreground colour. */
  syntaxHighlighting: {
    default: true,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Glide the left rail and right dock open and closed. When off they snap
   *  instantly, with no width animation. */
  railGlide: {
    default: true,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Rail/dock glide duration in ms. Only used when `railGlide` is on. */
  railGlideMs: {
    default: DEFAULT_RAIL_GLIDE_MS,
    exported: true,
    reset: true,
    parse: intIn(120, 1200),
  } satisfies PrefSpec<number>,

  /** Draw a continuous vertical rule down the transcript, with each row's
   *  marker sitting on it, so a turn reads as one thread of work instead of a
   *  stack of separate cards. Purely visual — off is today's look. */
  transcriptSpine: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Pin each user message to the top of the transcript while its reply
   *  scrolls underneath, so the question stays on screen through a long
   *  answer. Purely visual — off is today's look. */
  transcriptStickyUser: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** How reasoning blocks show. See `TranscriptReasoning`. */
  transcriptReasoning: {
    default: "live",
    exported: true,
    reset: true,
    parse: oneOf(["live", "folded", "hidden"] as const),
  } satisfies PrefSpec<TranscriptReasoning>,

  /** Leave a finished run of tool calls open instead of folding it to its
   *  "5 calls · 5 done" summary. The run's body is height-capped either way,
   *  so an open run scrolls inside itself rather than stretching the reply. */
  transcriptToolRunsOpen: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Draw Copy / Retry under each message at full strength instead of dimmed
   *  until hover. For touch screens and for readers who find the dimmed row
   *  hard to see. */
  transcriptActionsVisible: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Show the clock time each reply started beside "Worked 4m" in its footer,
   *  so a long chat can be read back against the day. */
  transcriptTimestamps: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Fade each new tool call in, one after another, and keep a finished run
   *  open for a moment before it folds, so a fast model's parallel batch does
   *  not snap onto the screen and away again. Reduce motion drops the fade and
   *  keeps the pause. */
  transcriptSmoothTools: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** How streamed reply text is revealed. See `TranscriptTextPace`. */
  transcriptTextPace: {
    default: "eased",
    exported: true,
    reset: true,
    parse: oneOf(["eased", "steady", "instant"] as const),
  } satisfies PrefSpec<TranscriptTextPace>,

  /** A one-line tally under a finished reply that used tools: files changed
   *  with their line counts, commands run, tokens the model generated. */
  transcriptTurnSummary: {
    default: false,
    exported: true,
    reset: true,
    parse: bool,
  } satisfies PrefSpec<boolean>,

  /** Where the composer model selector sits: the top control row (left) or the
   *  bottom action row (right). */
  modelSelectorPosition: {
    default: "bottom",
    exported: true,
    reset: false,
    note: "Lives on the Preferences page, and 'Reset appearance' has never cleared it. It still EXPORTS, because where the model selector sits is part of the look someone is sharing.",
    parse: oneOf(["top", "bottom"] as const),
  } satisfies PrefSpec<ModelSelectorPosition>,

  /** Keyboard chord that opens the agent-window command center. */
  commandCenterShortcut: {
    default: "Mod+K",
    exported: false,
    reset: false,
    note: "A keyboard chord is not a look. Importing a theme must never silently rebind a key the user reaches for, so this is the one preference the JSON does not carry.",
    parse: str,
  } satisfies PrefSpec<string>,
} as const;

export type AppearancePrefKey = keyof typeof APPEARANCE_PREFS;

/**
 * The value type of each preference, derived from its PARSER's return type
 * rather than from `default`.
 *
 * The table is `as const` so the flags stay literal and exhaustive, which also
 * narrows `default: false` to the type `false`. Reading the types off the
 * defaults would therefore give a store whose `reduceMotion` can only ever be
 * `false` — and every `set` of `true` is a type error. The parser already
 * states the real domain (`boolean`, `AgentUiVersion`, `number`), so take it
 * from there; `NonNullable` strips the `| null` that means "skip this value".
 */
export type AppearancePrefs = {
  [K in AppearancePrefKey]: NonNullable<
    ReturnType<(typeof APPEARANCE_PREFS)[K]["parse"]>
  >;
};

const KEYS = Object.keys(APPEARANCE_PREFS) as AppearancePrefKey[];

/** Every preference at its shipped value. The store's initial state and
 *  "Reset appearance" both start here. */
export function defaultAppearancePrefs(): AppearancePrefs {
  const out = {} as Record<AppearancePrefKey, unknown>;
  for (const key of KEYS) out[key] = APPEARANCE_PREFS[key].default;
  return out as AppearancePrefs;
}

/** Only the preferences "Reset appearance" is allowed to clear. */
export function resettableAppearancePrefs(): Partial<AppearancePrefs> {
  const out = {} as Record<string, unknown>;
  for (const key of KEYS) {
    if (APPEARANCE_PREFS[key].reset) out[key] = APPEARANCE_PREFS[key].default;
  }
  return out as Partial<AppearancePrefs>;
}

/**
 * True when any resettable preference differs from its default. This is what
 * enables the Reset button, and it is derived from the SAME flag the reset
 * itself uses — before the table, the two disagreed: turning on the transcript
 * spine left the button disabled, yet Reset would have switched it off.
 */
export function hasAppearancePrefChanges(current: AppearancePrefs): boolean {
  return KEYS.some(
    (key) => APPEARANCE_PREFS[key].reset && current[key] !== APPEARANCE_PREFS[key].default,
  );
}

/** The subset that travels in an exported file. */
export function exportableAppearancePrefs(
  current: AppearancePrefs,
): Partial<AppearancePrefs> {
  const out = {} as Record<string, unknown>;
  for (const key of KEYS) {
    if (APPEARANCE_PREFS[key].exported) out[key] = current[key];
  }
  return out as Partial<AppearancePrefs>;
}

/**
 * Read a `preferences` object out of an imported file.
 *
 * Absent keys are ABSENT from the result, never defaulted — an import applies
 * what the file carries and leaves everything else exactly as the user has it.
 * A key that is present but unusable is dropped and counted in `skipped`, so
 * the UI can say the file was partly understood instead of silently ignoring
 * half of it.
 */
export function parseAppearancePrefs(raw: unknown): {
  prefs: Partial<AppearancePrefs>;
  applied: number;
  skipped: string[];
} {
  const prefs = {} as Record<string, unknown>;
  const skipped: string[] = [];
  if (!raw || typeof raw !== "object") return { prefs, applied: 0, skipped };
  const source = raw as Record<string, unknown>;
  let applied = 0;
  for (const key of KEYS) {
    if (!(key in source)) continue;
    // A non-exported preference is not read back either, even when a
    // hand-edited file carries it: the export contract runs both ways.
    if (!APPEARANCE_PREFS[key].exported) {
      skipped.push(key);
      continue;
    }
    const parsed = APPEARANCE_PREFS[key].parse(source[key]);
    if (parsed === null) {
      skipped.push(key);
      continue;
    }
    prefs[key] = parsed;
    applied += 1;
  }
  return { prefs: prefs as Partial<AppearancePrefs>, applied, skipped };
}
