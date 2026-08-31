import { beforeEach, describe, expect, it } from "vitest";

import {
  isFastOn,
  readFastPreferences,
  resetFastPreferenceCache,
  setFastOn,
} from "./cursor-fast";

beforeEach(() => {
  localStorage.clear();
  resetFastPreferenceCache();
});

describe("what Fast is filed under", () => {
  it("round-trips on a model row id", () => {
    setFastOn("cursor::composer-2.5", true);
    resetFastPreferenceCache();

    expect(isFastOn("cursor::composer-2.5")).toBe(true);
  });

  it("does not answer for a selection string", () => {
    // The key is the row's database identity, not `provider:model`. Those two
    // were mixed before — the picker wrote one, the send path read the other —
    // and the switch showed on while every turn ran on the slow lane.
    setFastOn("cursor::composer-2.5", true);

    expect(isFastOn("cursor:composer-2.5")).toBe(false);
  });

  it("turns off completely", () => {
    setFastOn("cursor::composer-2.5", true);
    setFastOn("cursor::composer-2.5", false);

    expect(isFastOn("cursor::composer-2.5")).toBe(false);
    expect(readFastPreferences()).toEqual({});
  });

  it("keeps models apart", () => {
    setFastOn("cursor::composer-2.5", true);

    expect(isFastOn("cursor::cursor-grok-4.6")).toBe(false);
  });
});
