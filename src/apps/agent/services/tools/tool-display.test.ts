import { describe, expect, it } from "vitest";
import { getProfessionalToolName } from "./tool-display";
import { describeToolActivity } from "@/apps/agent/components/conversation/activity";

describe("research tool names", () => {
  it.each([
    [{ query: "Webb" }, "Search the Web"],
    [{ query: "Webb", source: "images" }, "Search Images"],
    [{ query: "Webb", source: "scholar" }, "Search Research Papers"],
    [{ url: "https://example.com" }, "Read Web Page"],
    [{ action: "fetch", query: "ignored", url: "https://example.com", offset: 30 }, "Read More of Page"],
    [{ action: "search", query: "Webb", url: "", source: "images" }, "Search Images"],
  ])("names the operation in %j", (args, title) => {
    expect(getProfessionalToolName("auroro_websearch", args)).toBe(title);
  });
  it("narrates an explicit fetch even if the caller also supplies a query", () => {
    expect(describeToolActivity("auroro_websearch", JSON.stringify({ action: "fetch", url: "https://example.com", query: "ignored" })).label)
      .toBe("Fetching https://example.com");
  });
  it("names image discovery and editing separately from generation", () => {
    expect(getProfessionalToolName("generate_image", { op: "list" })).toBe("List Image Models");
    expect(getProfessionalToolName("generate_image", { op: "edit" })).toBe("Edit Image");
    expect(getProfessionalToolName("generate_image", { op: "generate" })).toBe("Generate Image");
    expect(getProfessionalToolName("generate_image", { prompt: "A city" })).toBe("Generate Image");
    expect(getProfessionalToolName("generate_image", {})).toBe("Image Tools");
    expect(getProfessionalToolName("generate_image")).toBe("Image Tools");
    expect(describeToolActivity("auroro_websearch", '{"source":"images","query":"Webb"}').label).toContain("Searching images");
  });
});
