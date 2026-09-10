/**
 * Volcano Ark — the wire picker, which is the part that can silently 404.
 *
 * Every other multi-wire provider in Aurora (kenari, Modal, Meta) mounts its
 * wires on one base URL, so switching one is just a provider type. Ark does
 * not: messages is `/api/coding/v1`, chat completions and responses are
 * `/api/coding/v3`. A wire swap that forgets the URL points the row at a path
 * that does not exist, and these tests are here so that cannot happen quietly.
 */

import { describe, expect, it } from "vitest";

import {
  arkBaseUrlForWire,
  arkResetLabel,
  arkTierLabel,
  arkWire,
  ARK_BASE_URL,
  ARK_MESSAGES_BASE_URL,
  ARK_WIRES,
  isArkProvider,
  isArkWireChoice,
  type ArkWire,
} from "./ark";
import { resolveProviderType } from "@/kernel/store/useSettingsStore";

const row = (providerType?: string) => ({ id: "ark", providerType } as never);

describe("arkWire", () => {
  it("reads each wire back from the provider type", () => {
    expect(arkWire(row("ark"))).toBe("ark");
    expect(arkWire(row("ark-messages"))).toBe("ark-messages");
    expect(arkWire(row("ark-responses"))).toBe("ark-responses");
  });

  /**
   * A row seeded before the picker existed carries `ark` or nothing. Messages
   * is the default answer because it is the recommended wire, and because the
   * seeded preset is a messages row.
   */
  it("falls back to Messages for a row with no wire set", () => {
    expect(arkWire(row(undefined))).toBe("ark-messages");
    expect(arkWire(row(""))).toBe("ark-messages");
  });
});

describe("arkBaseUrlForWire", () => {
  /** The whole reason this function exists. */
  it("moves the base URL between the two paths", () => {
    expect(arkBaseUrlForWire("ark-messages")).toBe(ARK_MESSAGES_BASE_URL);
    expect(arkBaseUrlForWire("ark")).toBe(ARK_BASE_URL);
    expect(arkBaseUrlForWire("ark-responses")).toBe(ARK_BASE_URL);
    expect(ARK_MESSAGES_BASE_URL).not.toBe(ARK_BASE_URL);
  });

  /**
   * The adapters append `/messages` and `/chat/completions` respectively, so a
   * wire's URL has to end on the version segment its own shape lives under.
   * `/api/coding/v1/chat/completions` and `/api/coding/v3/messages` are both
   * 404s.
   */
  it("ends each wire's URL on the version segment its adapter expects", () => {
    expect(arkBaseUrlForWire("ark-messages").endsWith("/api/coding/v1")).toBe(true);
    expect(arkBaseUrlForWire("ark").endsWith("/api/coding/v3")).toBe(true);
    expect(arkBaseUrlForWire("ark-responses").endsWith("/api/coding/v3")).toBe(true);
  });

  /**
   * Both wires must stay under `/api/coding`. The same key on Ark's general
   * `/api/v3` succeeds and spends pay-as-you-go credit instead of the
   * subscription — nothing fails, the quota just never moves.
   */
  it("keeps every wire on the coding path", () => {
    for (const { value } of ARK_WIRES) {
      expect(arkBaseUrlForWire(value)).toContain("/api/coding");
    }
  });

  it("offers a URL for every wire the picker lists", () => {
    const listed = ARK_WIRES.map((w) => w.value).sort();
    expect(listed).toEqual(["ark", "ark-messages", "ark-responses"]);
    // Messages first: it is the default and the recommended one.
    expect(ARK_WIRES[0].value).toBe<ArkWire>("ark-messages");
  });
});

describe("isArkWireChoice — surviving the launch merge", () => {
  /**
   * The launch merge lets the catalogue's provider type win, keeping a stored
   * one only when it looks like a `-` suffixed variant of the preset's. Ark's
   * preset type IS a variant (`ark-messages`), so that test cannot see the
   * other two wires as siblings — without this carve-out the picker resets on
   * every launch, which is the failure mode where a control appears to save,
   * works all session, and is gone by morning.
   */
  it("protects every wire the picker offers", () => {
    for (const { value } of ARK_WIRES) {
      expect(isArkWireChoice({ id: "ark", providerType: value })).toBe(true);
    }
  });

  /** A stale or foreign value must still self-heal to the preset's. */
  it("does not protect a value the picker never sets", () => {
    expect(isArkWireChoice({ id: "ark", providerType: "openai" })).toBe(false);
    expect(isArkWireChoice({ id: "ark", providerType: "custom" })).toBe(false);
    expect(isArkWireChoice({ id: "ark", providerType: undefined })).toBe(false);
  });

  /**
   * The reason the carve-out is needed, pinned as arithmetic rather than left
   * in a comment: the generic resolver silently discards two of three wires.
   */
  it("documents that the generic resolver would lose the choice", () => {
    expect(resolveProviderType("ark-messages", "ark")).toBe("ark-messages");
    expect(resolveProviderType("ark-messages", "ark-responses")).toBe("ark-messages");
    // Contrast with kenari, whose preset type is the bare name, so its own
    // variants pass the resolver's test unaided.
    expect(resolveProviderType("kenari", "kenari-messages")).toBe("kenari-messages");
  });
});

describe("isArkProvider", () => {
  it("recognises the row on every wire, not just the default", () => {
    expect(isArkProvider(row("ark"))).toBe(true);
    expect(isArkProvider(row("ark-messages"))).toBe(true);
    expect(isArkProvider(row("ark-responses"))).toBe(true);
  });

  /** A row someone added themselves carries a UUID and declares its type. */
  it("recognises a hand-added row by its type alone", () => {
    expect(isArkProvider({ id: "a3f9-uuid", providerType: "ark-messages" } as never)).toBe(
      true,
    );
  });

  it("does not claim rows belonging to other providers", () => {
    expect(isArkProvider({ id: "kenari", providerType: "kenari-messages" } as never)).toBe(
      false,
    );
    expect(isArkProvider({ id: "anthropic", providerType: "anthropic" } as never)).toBe(false);
  });
});

describe("arkResetLabel", () => {
  /** An INSTANT in unix seconds, where kenari sends a duration. */
  it("counts down to the timestamp the console sent", () => {
    const inOneHour = Math.floor(Date.now() / 1000) + 3_600;
    expect(arkResetLabel({ usedPercent: 1, resetsAtUnix: inOneHour })).toMatch(/^resets in /);
  });

  it("says a window past its reset resets now rather than counting backwards", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(arkResetLabel({ usedPercent: 1, resetsAtUnix: past })).toBe("resets now");
  });

  it("says nothing when the console sent no timestamp", () => {
    expect(arkResetLabel({ usedPercent: 1, resetsAtUnix: null })).toBeNull();
    expect(arkResetLabel(null)).toBeNull();
  });
});

describe("arkTierLabel", () => {
  it("capitalises Volcano's own two names", () => {
    expect(arkTierLabel("pro")).toBe("Pro");
    expect(arkTierLabel("lite")).toBe("Lite");
  });

  /** A third plan appearing later should show its real name, not vanish. */
  it("passes an unfamiliar tier through rather than dropping it", () => {
    expect(arkTierLabel("team")).toBe("Team");
    expect(arkTierLabel(null)).toBeNull();
  });
});
