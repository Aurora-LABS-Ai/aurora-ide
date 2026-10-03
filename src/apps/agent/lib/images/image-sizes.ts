/**
 * Image model sizes — the list a model accepts and which one it uses by
 * default (pure). Backs the size editor in Settings → Providers → Image
 * providers.
 *
 * Sizes are compared as exact strings by the Rust command
 * (`image_direct.rs` checks `resolved.model.sizes.iter().any(|s| s == size)`),
 * so everything that enters the list is normalized to one spelling first:
 * `1024x1024`, lowercase `x`, no spaces. `auto` is kept as the one word some
 * APIs accept in place of a size.
 */

/** Common sizes offered as one-click additions, roughly most-used first. */
export const SIZE_PRESETS: readonly string[] = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1792x1024",
  "1024x1792",
  "1280x720",
  "720x1280",
  "2048x2048",
  "512x512",
];

const AUTO = "auto";
const MIN_EDGE = 16;
const MAX_EDGE = 16384;

/** `" 1024 × 1024 "` → `"1024x1024"`; `null` when it is not a size. */
export function normalizeSize(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (text === AUTO) return AUTO;
  const match = /^(\d+)[x×*](\d+)$/.exec(text);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ok = (n: number) => Number.isInteger(n) && n >= MIN_EDGE && n <= MAX_EDGE;
  return ok(width) && ok(height) ? `${width}x${height}` : null;
}

const NAMED_RATIOS: ReadonlyArray<[number, string]> = [
  [1, "1:1"],
  [4 / 3, "4:3"],
  [3 / 2, "3:2"],
  [16 / 9, "16:9"],
  [7 / 4, "7:4"],
  [21 / 9, "21:9"],
  [3 / 4, "3:4"],
  [2 / 3, "2:3"],
  [9 / 16, "9:16"],
  [4 / 7, "4:7"],
];

/**
 * A short shape label: `1:1`, `3:2`, `9:16`. Snaps to a familiar ratio within
 * 3%, because a provider's `1664x928` is "16:9" to a person, not "52:29".
 * Empty for `auto` or anything unparseable.
 */
export function sizeRatioLabel(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return "";
  const ratio = Number(match[1]) / Number(match[2]);
  for (const [value, label] of NAMED_RATIOS) {
    if (Math.abs(ratio - value) / value <= 0.03) return label;
  }
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

export interface SizeSet {
  sizes: string[];
  defaultSize?: string;
}

/**
 * Add a size. Returns the set unchanged when it is not a size or is already
 * listed. The first size added becomes the default, so a model never has a
 * list and no default.
 */
export function addSize(set: SizeSet, raw: string): SizeSet {
  const size = normalizeSize(raw);
  if (!size || set.sizes.includes(size)) return set;
  const sizes = [...set.sizes, size];
  return { sizes, defaultSize: set.defaultSize && set.sizes.includes(set.defaultSize) ? set.defaultSize : sizes[0] };
}

/** Remove a size; removing the default hands it to the first one left. */
export function removeSize(set: SizeSet, size: string): SizeSet {
  const sizes = set.sizes.filter((s) => s !== size);
  const defaultSize = set.defaultSize === size || !set.defaultSize ? sizes[0] : set.defaultSize;
  return { sizes, defaultSize };
}

/** Make a listed size the default. Ignored for a size that is not listed. */
export function setDefaultSize(set: SizeSet, size: string): SizeSet {
  return set.sizes.includes(size) ? { ...set, defaultSize: size } : set;
}
