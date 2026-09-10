/**
 * Provider categories — the folders you make, and what lives in them.
 *
 * ## Why the rail needed this
 *
 * Forty-five providers, thirty-two of them added by hand, is past the size
 * where "Built-in" and "Custom" say anything useful. Both halves of that split
 * describe where a row CAME FROM, which stops mattering the moment there are
 * six coding-plan subscriptions in one bucket and four relays that need
 * checking in the other. A category says what a row IS FOR, which is the
 * question actually being asked when someone opens this page.
 *
 * ## The two rules that shape everything here
 *
 * **A provider is in exactly one category.** Not none, not two. The rail
 * already teaches exclusive membership through Pinned — a pinned provider
 * leaves its group rather than appearing twice — and a row that renders in two
 * places is a row you cannot reason about when the counts disagree. Labels
 * with multiple membership are a different feature; see the design probe
 * (`Documents/aurora-provider-categories-designs.html`) for why that was
 * rejected for this one.
 *
 * **The two system categories cannot be removed.** Every provider needs a
 * home, including the thirteen that ship with Aurora and the ones already on
 * disk before categories existed, so {@link BUILT_IN_CATEGORY_ID} and
 * {@link CUSTOM_CATEGORY_ID} always exist and always accept rows. They are the
 * unfiled pile, which is why they sort BELOW the ones you made: your own
 * categories are what you reach for, and the shipped split is what is left.
 *
 * A category is a fact about the account rather than a preference of this
 * window — it will group the model selector too — so unlike pinning
 * (`settings/provider-pins.ts`, localStorage) this persists to the database
 * with the rest of the settings.
 */

/** How a category is stored. Ids are generated, names are the user's. */
export interface ProviderCategory {
  id: string;
  name: string;
  /**
   * A quiet dot beside the name, so a category is findable by shape as well as
   * by reading. One of {@link CATEGORY_COLORS}; anything else falls back to
   * the neutral one rather than painting an arbitrary hex into the rail.
   */
  color: CategoryColor;
  /** Ascending. Contiguous after every mutation, so no two rows tie. */
  order: number;
  /**
   * True for the two Aurora seeds. A system category can be collapsed and can
   * receive providers, but it cannot be renamed, recoloured or deleted: its
   * name is a statement about where its rows came from, and a renamed one
   * would describe rows it does not match.
   */
  system?: boolean;
}

/**
 * The colours a category may carry, as token names rather than hex.
 *
 * Deliberately short and all drawn from the existing palette
 * (`.knowledge/design-tokens.md`) — a colour picker here would let someone
 * build a rail that fights the theme, and the dot is an aid to scanning, not
 * decoration.
 */
export const CATEGORY_COLORS = [
  "neutral",
  "accent",
  "added",
  "warning",
  "removed",
  "info",
] as const;

export type CategoryColor = (typeof CATEGORY_COLORS)[number];

/** The shipped rows' home. */
export const BUILT_IN_CATEGORY_ID = "sys-built-in";
/** Everything the user added and has not filed. */
export const CUSTOM_CATEGORY_ID = "sys-custom";

/** Longest a category name may be. A rail label, not a note. */
export const CATEGORY_NAME_MAX = 32;

/**
 * What gets stored: the categories, plus which category each provider is in.
 *
 * The assignment lives in a lookup keyed by provider id rather than as a field
 * on the provider row, for the same reason `removedProviderIds` does: built-in
 * provider rows are re-seeded from the Rust catalogue on every launch, and a
 * field on the row would have to survive that merge. A separate map is not
 * touched by it at all.
 */
export interface ProviderCategoryState {
  categories: ProviderCategory[];
  /** `providerId` → `categoryId`. A provider absent here is unfiled. */
  assignments: Record<string, string>;
}

/** The two seeds, in the order they sort. */
function systemCategories(): ProviderCategory[] {
  return [
    {
      id: BUILT_IN_CATEGORY_ID,
      name: "Built-in",
      color: "neutral",
      // Large, so anything the user makes sorts above without renumbering.
      // The two seeds keep the last two slots for the life of the install.
      order: 1_000_000,
      system: true,
    },
    {
      id: CUSTOM_CATEGORY_ID,
      name: "Custom",
      color: "neutral",
      order: 1_000_001,
      system: true,
    },
  ];
}

export function emptyProviderCategoryState(): ProviderCategoryState {
  return { categories: systemCategories(), assignments: {} };
}

const isColor = (value: unknown): value is CategoryColor =>
  typeof value === "string" && (CATEGORY_COLORS as readonly string[]).includes(value);

/**
 * Trim a name to something a rail label can hold, or `null` if nothing is left.
 *
 * Whitespace collapses so a name cannot be made of spaces, and a name that
 * reduces to nothing is refused rather than stored as an unclickable blank
 * header.
 */
export function normalizeCategoryName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, CATEGORY_NAME_MAX);
  return name.length > 0 ? name : null;
}

/**
 * Read whatever was on disk back into a shape the rail can render.
 *
 * Defensive on purpose: this is a JSON blob in `app_settings`, so a hand-edited
 * database, an older build, or a half-written value must degrade to a working
 * rail rather than throw on the settings load and take the whole page with it.
 * The two system categories are re-added whenever they are missing, because a
 * provider with nowhere to live would vanish from the page entirely.
 */
export function normalizeProviderCategories(raw: unknown): ProviderCategoryState {
  if (!raw || typeof raw !== "object") return emptyProviderCategoryState();
  const source = raw as Record<string, unknown>;

  const seen = new Set<string>();
  const categories: ProviderCategory[] = [];
  if (Array.isArray(source.categories)) {
    for (const entry of source.categories) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : "";
      if (!id || seen.has(id)) continue;
      const name = typeof row.name === "string" ? normalizeCategoryName(row.name) : null;
      if (!name) continue;
      seen.add(id);
      categories.push({
        id,
        name,
        color: isColor(row.color) ? row.color : "neutral",
        order: typeof row.order === "number" && Number.isFinite(row.order) ? row.order : 0,
        // Never trusted from disk: system-ness is decided by id below, so a
        // stored `system: true` on a user category cannot make it undeletable.
        system: false,
      });
    }
  }

  // The seeds are re-asserted rather than merged, so their names and their
  // undeletable flag are always Aurora's regardless of what was written.
  for (const seed of systemCategories()) {
    const at = categories.findIndex((c) => c.id === seed.id);
    if (at === -1) categories.push(seed);
    else categories[at] = seed;
  }

  categories.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const assignments: Record<string, string> = {};
  if (source.assignments && typeof source.assignments === "object") {
    const known = new Set(categories.map((c) => c.id));
    for (const [providerId, categoryId] of Object.entries(
      source.assignments as Record<string, unknown>,
    )) {
      // An assignment to a category that no longer exists is dropped, which
      // returns the provider to its unfiled home rather than hiding it in a
      // group the rail will never draw.
      if (typeof categoryId === "string" && known.has(categoryId)) {
        assignments[providerId] = categoryId;
      }
    }
  }

  return { categories, assignments };
}

/** Renumber user categories 0..n so ordering stays contiguous and stable. */
function renumber(categories: ProviderCategory[]): ProviderCategory[] {
  const user = categories.filter((c) => !c.system).sort((a, b) => a.order - b.order);
  const system = categories.filter((c) => c.system);
  return [...user.map((c, i) => ({ ...c, order: i })), ...system];
}

/**
 * Add a category. Returns the new state and the new id, or `null` when the
 * name is empty or already taken.
 *
 * Duplicate names are refused rather than allowed: two identically named
 * sections in one rail cannot be told apart, and "which Coding plans did I put
 * Kenari in" has no answer. The comparison is case-insensitive, because
 * `Coding plans` and `coding plans` are the same mistake.
 */
export function addCategory(
  state: ProviderCategoryState,
  rawName: string,
  color: CategoryColor = "neutral",
): { state: ProviderCategoryState; id: string } | null {
  const name = normalizeCategoryName(rawName);
  if (!name) return null;
  if (state.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return null;
  const id = `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const nextOrder =
    state.categories.filter((c) => !c.system).reduce((max, c) => Math.max(max, c.order), -1) + 1;
  return {
    state: {
      categories: renumber([...state.categories, { id, name, color, order: nextOrder }]),
      assignments: state.assignments,
    },
    id,
  };
}

/** Rename a user category. Returns `null` when refused, leaving state alone. */
export function renameCategory(
  state: ProviderCategoryState,
  id: string,
  rawName: string,
): ProviderCategoryState | null {
  const target = state.categories.find((c) => c.id === id);
  if (!target || target.system) return null;
  const name = normalizeCategoryName(rawName);
  if (!name) return null;
  if (name === target.name) return state;
  if (
    state.categories.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())
  ) {
    return null;
  }
  return {
    categories: state.categories.map((c) => (c.id === id ? { ...c, name } : c)),
    assignments: state.assignments,
  };
}

export function recolorCategory(
  state: ProviderCategoryState,
  id: string,
  color: CategoryColor,
): ProviderCategoryState {
  const target = state.categories.find((c) => c.id === id);
  if (!target || target.system) return state;
  return {
    categories: state.categories.map((c) => (c.id === id ? { ...c, color } : c)),
    assignments: state.assignments,
  };
}

/**
 * Delete a user category. **Its providers are not deleted** — they are returned
 * to their unfiled home, which is what `fallbackFor` decides per provider.
 *
 * Emptying the category rather than refusing to delete a non-empty one is the
 * kinder failure: the alternative makes someone move six rows by hand before
 * they are allowed to undo a naming decision.
 */
export function deleteCategory(
  state: ProviderCategoryState,
  id: string,
): ProviderCategoryState {
  const target = state.categories.find((c) => c.id === id);
  if (!target || target.system) return state;
  const assignments: Record<string, string> = {};
  for (const [providerId, categoryId] of Object.entries(state.assignments)) {
    if (categoryId !== id) assignments[providerId] = categoryId;
  }
  return {
    categories: renumber(state.categories.filter((c) => c.id !== id)),
    assignments,
  };
}

/** Move one category above or below its neighbour. */
export function moveCategory(
  state: ProviderCategoryState,
  id: string,
  direction: -1 | 1,
): ProviderCategoryState {
  const user = state.categories.filter((c) => !c.system).sort((a, b) => a.order - b.order);
  const at = user.findIndex((c) => c.id === id);
  const to = at + direction;
  if (at === -1 || to < 0 || to >= user.length) return state;
  const reordered = [...user];
  [reordered[at], reordered[to]] = [reordered[to], reordered[at]];
  return {
    categories: renumber([
      ...reordered.map((c, i) => ({ ...c, order: i })),
      ...state.categories.filter((c) => c.system),
    ]),
    assignments: state.assignments,
  };
}

/**
 * File a provider under a category, or unfile it when `categoryId` is null.
 *
 * Assigning the provider's own system home is stored as UNFILED rather than as
 * an explicit assignment. Otherwise a built-in row moved to Built-in and one
 * never touched would be two different stored states that draw identically,
 * and the difference would only ever surface as a bug.
 */
export function assignProviderToCategory(
  state: ProviderCategoryState,
  providerId: string,
  categoryId: string | null,
  isCustom: boolean,
): ProviderCategoryState {
  const assignments = { ...state.assignments };
  const home = fallbackFor(isCustom);
  if (!categoryId || categoryId === home || !state.categories.some((c) => c.id === categoryId)) {
    delete assignments[providerId];
  } else {
    assignments[providerId] = categoryId;
  }
  return { categories: state.categories, assignments };
}

/** Which system category an unfiled provider belongs to. */
export function fallbackFor(isCustom: boolean): string {
  return isCustom ? CUSTOM_CATEGORY_ID : BUILT_IN_CATEGORY_ID;
}

/** The category a provider renders under, filed or not. */
export function categoryOf(
  state: ProviderCategoryState,
  provider: { id: string; isCustom?: boolean },
): string {
  return state.assignments[provider.id] ?? fallbackFor(!!provider.isCustom);
}

/**
 * The rail's sections: your categories in your order, then the two seeds.
 *
 * Every provider appears exactly once. A user category with nothing in it is
 * still returned — it has to be, or a category you just made would not appear
 * until you filled it, and there would be nowhere to drop the first row.
 * The two system sections are omitted when empty, because those are not places
 * you put things, they are what is left over.
 */
export function sectionsFor<T extends { id: string; isCustom?: boolean }>(
  state: ProviderCategoryState,
  providers: readonly T[],
): Array<{ category: ProviderCategory; providers: T[] }> {
  const byCategory = new Map<string, T[]>();
  for (const provider of providers) {
    const key = categoryOf(state, provider);
    const list = byCategory.get(key);
    if (list) list.push(provider);
    else byCategory.set(key, [provider]);
  }
  const ordered = [...state.categories].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );
  const sections: Array<{ category: ProviderCategory; providers: T[] }> = [];
  for (const category of ordered) {
    const rows = byCategory.get(category.id) ?? [];
    if (category.system && rows.length === 0) continue;
    sections.push({ category, providers: rows });
  }
  return sections;
}
