import { describe, expect, it } from "vitest";

import {
  extractStreamingStringField,
  getParsedReplacementsArg,
  getStreamingBooleanArg,
  getStreamingStringArg,
  isLivePreviewTool,
} from "./live-file-preview-utils";

describe("live-file-preview-utils", () => {
  it("extracts incomplete streamed string fields without waiting for valid JSON", () => {
    const raw = '{"path":"src/example.ts","content":"export const value = 1;\\n';

    expect(extractStreamingStringField(raw, "path")).toEqual({
      value: "src/example.ts",
      complete: true,
    });
    expect(extractStreamingStringField(raw, "content")).toEqual({
      value: "export const value = 1;\n",
      complete: false,
    });
  });

  it("preserves invalid Windows path backslashes while extracting streamed fields", () => {
    const raw = '{"path":"E:\\VOID-EDITOR\\Aurora-Agent-IDE\\src\\file.ts","content":"x';

    expect(getStreamingStringArg(raw, "path")).toEqual({
      value: "E:\\VOID-EDITOR\\Aurora-Agent-IDE\\src\\file.ts",
      complete: true,
    });
  });

  it("prefers repaired full JSON parsing when arguments are complete", () => {
    const raw = '{"path":"E:\\VOID-EDITOR\\Aurora-Agent-IDE\\src\\file.ts","content":"done"}';

    expect(getStreamingStringArg(raw, "content")).toEqual({
      value: "done",
      complete: true,
    });
  });

  it("extracts boolean and batch replacement arguments safely", () => {
    expect(getStreamingBooleanArg('{"replace_all":true,"new_string":"x', "replace_all")).toBe(true);
    expect(
      getParsedReplacementsArg(
        '{"replacements":[{"old_string":"before","new_string":"after","replace_all":true}]}',
      ),
    ).toEqual([
      {
        old_string: "before",
        new_string: "after",
        replace_all: true,
      },
    ]);
    expect(getParsedReplacementsArg('{"replacements":[{"old_string":"before"')).toBeNull();
  });

  it("recognizes only tools with live editor previews", () => {
    expect(isLivePreviewTool("file_create")).toBe(true);
    expect(isLivePreviewTool("file_write")).toBe(true);
    expect(isLivePreviewTool("search_replace")).toBe(true);
    expect(isLivePreviewTool("multi_search_replace")).toBe(true);
    expect(isLivePreviewTool("file_read")).toBe(false);
  });
});
