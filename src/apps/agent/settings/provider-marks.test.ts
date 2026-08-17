import { describe, expect, it } from "vitest";

import { BRAND_KEYS } from "@/apps/agent/services/providers/provider-brands";
import { IMAGE_MARKS, PROVIDER_MARKS } from "./provider-marks";

describe("provider marks", () => {
  it("has a real mark for every brand detection can return", () => {
    // The failure this catches is silent: a renamed or removed export from
    // `@lobehub/icons` leaves `undefined` in the record, React renders nothing,
    // and the row shows an empty tile — which reads as a broken build rather
    // than as a missing logo. TypeScript does not catch it because a bad
    // `.Color` on a component that HAS other variants still types as a
    // component.
    for (const brand of BRAND_KEYS) {
      const mark = PROVIDER_MARKS[brand];
      expect(mark, `${brand} has no mark component`).toBeTruthy();
      expect(
        typeof mark === "function" || typeof mark === "object",
        `${brand} resolved to ${typeof mark}, which React cannot render`,
      ).toBe(true);
    }
  });

  it("covers every brand and invents none", () => {
    // Both directions. A key in the record that detection can never produce is
    // dead weight; a brand detection can produce with no entry is an empty tile.
    expect(Object.keys(PROVIDER_MARKS).sort()).toEqual([...BRAND_KEYS].sort());
  });

  it("points every image mark at a file that ships with the app", () => {
    // A remote URL would simply not load — the agent window runs behind a
    // strict CSP — so these have to be root-relative paths served from
    // `public/`.
    for (const [brand, src] of Object.entries(IMAGE_MARKS)) {
      expect(src.startsWith("/"), `${brand} mark is not app-local: ${src}`).toBe(true);
      expect(src).not.toMatch(/^\/\//);
    }
  });
});
