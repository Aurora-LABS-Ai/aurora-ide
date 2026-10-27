import { describe, expect, it } from "vitest";

import {
  matchesPickerFilters,
  parentFolder,
  pickInBrowser,
  setWebFilePicker,
} from "@/kernel/lib/ipc/web-file-picker";

describe("web file picker", () => {
  it("climbs to a drive root with its backslash, and stops there", () => {
    expect(parentFolder("C:\\Users\\Alvan")).toBe("C:\\Users");
    expect(parentFolder("C:\\Users")).toBe("C:\\");
    expect(parentFolder("C:\\")).toBeNull();
    expect(parentFolder("E:\\VOID-EDITOR\\")).toBe("E:\\");
    expect(parentFolder("/home/alvan")).toBe("/home");
    expect(parentFolder("/home")).toBe("/");
    expect(parentFolder("/")).toBeNull();
  });

  it("filters files by extension, any case", () => {
    const images = { directory: false, filters: [{ name: "Images", extensions: ["png", "jpg"] }] };
    expect(matchesPickerFilters("shot.PNG", images)).toBe(true);
    expect(matchesPickerFilters("notes.md", images)).toBe(false);
    expect(matchesPickerFilters("anything", { directory: false })).toBe(true);
  });

  it("answers null until a picker is registered, then asks it", async () => {
    expect(await pickInBrowser({ directory: true })).toBeNull();
    const stop = setWebFilePicker(async () => "E:\\repo");
    expect(await pickInBrowser({ directory: true })).toBe("E:\\repo");
    stop();
    expect(await pickInBrowser({ directory: true })).toBeNull();
  });
});
