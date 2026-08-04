/**
 * Model + token presentation shared by every usage surface.
 *
 * Extracted from `ProfileSettings` so the Profile page and the Project panel
 * cannot drift: two implementations of "what is this model called" is how one
 * page ends up showing `dd6cdd64-6368-4a53-9ff7-e178aa9a6bac:claude-opus-4-8-r`
 * while the other shows `Claude Opus 4.8`.
 */

export interface ModelCatalogEntry {
  modelKey: string;
  label?: string;
}

/**
 * `"deepseek:deepseek-v4-pro"` → the catalog label (`"DeepSeek V4 Pro"`) when
 * the model is known, else a cleaned-up key (`"Deepseek V4 Pro"`).
 *
 * The part before `:` is a provider instance — frequently a raw UUID — and is
 * always dropped. Raw ids look broken anywhere a person reads them.
 */
export function prettyModel(
  raw: string,
  models: ReadonlyArray<ModelCatalogEntry>,
): string {
  const value = (raw ?? "").trim();
  if (!value) return "Unknown model";

  const key = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  // A trailing colon leaves nothing after it; fall back to the raw value rather
  // than rendering an empty row.
  if (!key) return value;

  const known = models.find((m) => m.modelKey === key);
  if (known?.label) return known.label;

  return key
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => {
      // Short all-letter segments are acronyms: gpt → GPT, glm → GLM.
      // The letter test matters: without it `gpt-4o` became "GPT 4O", because
      // "4o" is also under the length cut.
      if (part.length <= 3 && /^[a-z]+$/i.test(part)) return part.toUpperCase();
      // Version-ish segments keep their case (`4o`, `5.2`); anything starting
      // with a letter is title-cased.
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/**
 * Compact token count: `1.7M`, `322K`, `812`.
 *
 * Trailing `.0` is dropped — `322.0K` reads as false precision on a figure
 * that is already rounded.
 */
export function formatTokens(n: number): string {
  const scale = (value: number, suffix: string): string => {
    const rounded = value.toFixed(1);
    return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded}${suffix}`;
  };
  if (n >= 1e9) return scale(n / 1e9, "B");
  if (n >= 1e6) return scale(n / 1e6, "M");
  if (n >= 1e3) return scale(n / 1e3, "K");
  return String(n);
}
