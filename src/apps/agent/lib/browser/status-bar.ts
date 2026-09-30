/**
 * The colour of a device's status bar, taken from the page — as a phone does.
 *
 * iOS Safari and Android Chrome tint the strip under the island / camera with
 * the page's `<meta name="theme-color">` when it has one (honouring its
 * `media` query, so a dark-mode colour wins in dark mode), and otherwise with
 * the colour at the top of the page. The clock and icons then go white or
 * black, whichever reads. A fixed white bar over a dark site is what no phone
 * ever shows.
 */

/** Runs in the page; returns a CSS colour string. */
export const STATUS_BAR_COLOR_SCRIPT = String.raw`(function () {
  function solid(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    if (p.length >= 4 && p[3] === 0) return null;
    return "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")";
  }
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var media = metas[i].getAttribute("media");
    var content = metas[i].getAttribute("content");
    if (content && (!media || matchMedia(media).matches)) return content;
  }
  var el = document.elementFromPoint(Math.floor(innerWidth / 2), 1);
  while (el) {
    var c = solid(getComputedStyle(el).backgroundColor);
    if (c) return c;
    el = el.parentElement;
  }
  return solid(getComputedStyle(document.documentElement).backgroundColor) || "rgb(255,255,255)";
})()`;

/**
 * Any CSS colour (`black`, `hsl(…)`, `#123`) as `rgb(r, g, b)`, resolved by
 * the browser itself. A page's theme-color may be written any way CSS allows;
 * `statusBarInk` only reads rgb/hex. `fallback` when the value is not a colour.
 */
export function normalizeCssColor(color: string, fallback = "rgb(255, 255, 255)"): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  if (!probe.style.color) return fallback;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || fallback;
}

/** `rgb(r,g,b)` / `rgba(...)` / `#rgb` / `#rrggbb` → [r, g, b], or null. */
export function parseRgb(color: string): [number, number, number] | null {
  const c = color.trim().toLowerCase();
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (!hex) return null;
  const h = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Light or dark clock and icons for a bar of `color`: WCAG relative luminance
 * against the midpoint where black and white text have equal contrast.
 * Unparseable colours read as light backgrounds (dark ink), the phone default.
 */
export function statusBarInk(color: string): "dark" | "light" {
  const rgb = parseRgb(color);
  if (!rgb) return "dark";
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? "dark" : "light";
}
