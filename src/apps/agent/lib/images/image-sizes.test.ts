import { describe, expect, it } from "vitest";

import { addSize, normalizeSize, removeSize, setDefaultSize, sizeRatioLabel } from "./image-sizes";

describe("image sizes", () => {
  it("normalizes the spellings people type to the one Rust compares", () => {
    expect(normalizeSize(" 1024 X 1024 ")).toBe("1024x1024");
    expect(normalizeSize("1536×1024")).toBe("1536x1024");
    expect(normalizeSize("AUTO")).toBe("auto");
  });

  it("rejects what is not a size", () => {
    expect(normalizeSize("big")).toBeNull();
    expect(normalizeSize("1024")).toBeNull();
    expect(normalizeSize("8x8")).toBeNull();
    expect(normalizeSize("99999x1024")).toBeNull();
  });

  it("labels shapes the way a person reads them", () => {
    expect(sizeRatioLabel("1024x1024")).toBe("1:1");
    expect(sizeRatioLabel("1536x1024")).toBe("3:2");
    expect(sizeRatioLabel("1664x928")).toBe("16:9");
    expect(sizeRatioLabel("720x1280")).toBe("9:16");
    expect(sizeRatioLabel("auto")).toBe("");
  });

  it("makes the first size the default and ignores duplicates", () => {
    const one = addSize({ sizes: [] }, "1024x1024");
    expect(one).toEqual({ sizes: ["1024x1024"], defaultSize: "1024x1024" });
    const two = addSize(one, "1536 x 1024");
    expect(two).toEqual({ sizes: ["1024x1024", "1536x1024"], defaultSize: "1024x1024" });
    expect(addSize(two, "1024X1024")).toBe(two);
    expect(addSize(two, "nonsense")).toBe(two);
  });

  it("hands the default on when the default is removed", () => {
    const set = { sizes: ["1024x1024", "1536x1024"], defaultSize: "1024x1024" };
    expect(removeSize(set, "1024x1024")).toEqual({ sizes: ["1536x1024"], defaultSize: "1536x1024" });
    expect(removeSize(set, "1536x1024")).toEqual({ sizes: ["1024x1024"], defaultSize: "1024x1024" });
    expect(removeSize({ sizes: ["1024x1024"], defaultSize: "1024x1024" }, "1024x1024")).toEqual({
      sizes: [],
      defaultSize: undefined,
    });
  });

  it("only makes a listed size the default", () => {
    const set = { sizes: ["1024x1024", "1536x1024"], defaultSize: "1024x1024" };
    expect(setDefaultSize(set, "1536x1024").defaultSize).toBe("1536x1024");
    expect(setDefaultSize(set, "2048x2048")).toBe(set);
  });
});
