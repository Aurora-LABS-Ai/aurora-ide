/**
 * How a computed number reads in an answer box.
 *
 * The model writes the quantity and its unit; this decides how it looks. A
 * model that formats its own numbers writes "1500 g" in one row and "2.0 kg"
 * in the next — the inconsistency the reference screenshot had.
 */

const CURRENCIES = new Set(["$", "£", "€", "¥", "₹"]);

/** Units that read better one step up past a thousand. */
const SCALE_UP: Record<string, string> = { g: "kg", ml: "L" };

const plain = (value: number, places?: number): string =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: places ?? 0,
    maximumFractionDigits: places ?? 2,
  });

/**
 * `unit` is whatever the model wrote after the formula:
 * - a currency symbol (`$ £ € ¥ ₹`) goes in front, with two decimals;
 * - `g` and `ml` move to `kg` and `L` from 1,000 up;
 * - `min` reads as hours and minutes past an hour;
 * - `%` sits against the number; anything else follows it after a space,
 *   with `singular/plural` picking the word for the number.
 *
 * `places` fixes the decimals when the model asked for them (`dp=1`).
 */
export function formatBoxValue(value: number, unit?: string, places?: number): string {
  const sign = value < 0 ? "−" : "";
  const size = Math.abs(value);
  if (!unit) return sign + plain(size, places);
  if (CURRENCIES.has(unit)) return `${sign}${unit}${plain(size, places ?? 2)}`;
  if (unit in SCALE_UP && size >= 1000) {
    return `${sign}${plain(size / 1000, places ?? 1)} ${SCALE_UP[unit]}`;
  }
  if (unit in SCALE_UP) return `${sign}${plain(Math.round(size), places)} ${unit}`;
  if (unit === "min" && size >= 60) {
    const total = Math.round(size);
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return `${sign}${hours} h${minutes ? ` ${minutes} min` : ""}`;
  }
  if (unit === "%") return `${sign}${plain(size, places)}%`;
  const slash = unit.indexOf("/");
  const word = slash > 0 ? (size === 1 ? unit.slice(0, slash) : unit.slice(slash + 1)) : unit;
  return `${sign}${plain(size, places)} ${word}`;
}
