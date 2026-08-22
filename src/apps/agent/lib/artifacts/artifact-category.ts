/**
 * What a canvas is ABOUT — the one list, read by three places.
 *
 * `artifactKind` already says how a canvas renders (markdown, mermaid, react).
 * It cannot say whether that markdown explains a data structure, an
 * architecture, an API contract or a roadmap — four different subjects wearing
 * the same extension. The category names the subject, and the tool card draws
 * a different miniature for each while the source streams.
 *
 * The schema enum, the runtime validator and the card's drawing all read THIS
 * array. They were nearly written as three lists; a settings-search bug in
 * August came from exactly that shape (one catalog, two front doors, silent
 * drift), so there is one array and everything derives from it.
 *
 * Leaf module: no JSX, no imports. The drawings live in
 * `components/tools/CanvasCategoryMark.tsx` and key off these ids.
 */

export type ArtifactCategory =
  | "architecture"
  | "flow"
  | "structure"
  | "api"
  | "roadmap"
  | "comparison"
  | "metrics"
  | "ui"
  | "report";

export interface ArtifactCategorySpec {
  readonly id: ArtifactCategory;
  /** Shown on the card's meta line. Sentence case — it sits mid-sentence. */
  readonly label: string;
  /** The clause the model reads when picking. Kept to one line on purpose. */
  readonly hint: string;
}

/**
 * Nine, ordered so the most common subjects in a coding workspace come first.
 * A long enum is the real failure mode here: overlapping choices make the model
 * pick near-randomly and the animation becomes confident noise. Each hint names
 * a subject that a person could assign without hesitating.
 */
export const ARTIFACT_CATEGORIES: readonly ArtifactCategorySpec[] = [
  {
    id: "architecture",
    label: "Architecture",
    hint: "how a system is put together — layers, services, modules, what owns what",
  },
  {
    id: "flow",
    label: "Flow",
    hint: "a process or lifecycle that proceeds in steps — a request path, a state machine",
  },
  {
    id: "structure",
    label: "Data structure",
    hint: "the shape of data — a schema, a type, a tree, a payload",
  },
  {
    id: "api",
    label: "API",
    hint: "an interface contract — endpoints, calls and what comes back",
  },
  {
    id: "roadmap",
    label: "Roadmap",
    hint: "a plan across time — phases, milestones, what ships when",
  },
  {
    id: "comparison",
    label: "Comparison",
    hint: "options weighed against each other — trade-offs, a decision matrix",
  },
  {
    id: "metrics",
    label: "Metrics",
    hint: "anything measured — cost, timings, benchmarks, usage",
  },
  {
    id: "ui",
    label: "Interface",
    hint: "a working screen — a mockup, a dashboard, a prototype with controls",
  },
  {
    id: "report",
    label: "Report",
    hint: "findings or an explanation in prose — and the fallback when none of the others fit",
  },
] as const;

/**
 * The home for "none of the above". Without one, a model forced to choose picks
 * the nearest wrong category and the card draws a confident lie.
 */
export const DEFAULT_ARTIFACT_CATEGORY: ArtifactCategory = "report";

export const ARTIFACT_CATEGORY_IDS: readonly ArtifactCategory[] =
  ARTIFACT_CATEGORIES.map((entry) => entry.id);

const BY_ID = new Map<string, ArtifactCategorySpec>(
  ARTIFACT_CATEGORIES.map((entry) => [entry.id, entry]),
);

/**
 * Anything unrecognised becomes the fallback rather than throwing. A category is
 * a presentation hint: refusing a whole canvas write because the model invented
 * `"diagram"` would trade a wrong drawing for a lost deliverable.
 */
export function normalizeArtifactCategory(value: unknown): ArtifactCategory {
  if (typeof value !== "string") return DEFAULT_ARTIFACT_CATEGORY;
  const key = value.trim().toLowerCase();
  return BY_ID.has(key) ? (key as ArtifactCategory) : DEFAULT_ARTIFACT_CATEGORY;
}

/** True only for a value the model actually chose from the list. */
export function isArtifactCategory(value: unknown): value is ArtifactCategory {
  return typeof value === "string" && BY_ID.has(value.trim().toLowerCase());
}

export function artifactCategoryLabel(value: unknown): string {
  return BY_ID.get(normalizeArtifactCategory(value))?.label ?? "Canvas";
}

/** The enum's prose, built from the list so the two can never disagree. */
export function artifactCategoryDescription(): string {
  const lines = ARTIFACT_CATEGORIES.map((entry) => `- ${entry.id}: ${entry.hint}`).join("\n");
  return `What this canvas is ABOUT, which is not what file it is — the same markdown \
document can explain an architecture, an API or a roadmap. Pick exactly one:

${lines}

Choose on the subject, never on the rendering format; \`artifactKind\` already carries that. \
Use \`${DEFAULT_ARTIFACT_CATEGORY}\` when none of the others genuinely fits.`;
}
