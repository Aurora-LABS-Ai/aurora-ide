import { describe, expect, it } from "vitest";

import { serializeEditor } from "@/apps/agent/lib/composer/serialize-editor";

describe("composer surface serialization", () => {
  it("omits Build file, terminal and project-rule pills from a Chat send", () => {
    const editor = document.createElement("div");
    editor.append("Please check ");
    const file = document.createElement("span");
    file.dataset.rel = "src/private.ts";
    editor.append(file, " and ");
    const terminal = document.createElement("span");
    terminal.dataset.term = "session-1";
    editor.append(terminal, " with ");
    const rule = document.createElement("span");
    rule.dataset.cmd = "rule:private.md";
    rule.dataset.cmdTitle = "private";
    editor.append(rule);

    expect(serializeEditor(editor, true)).toContain("@src/private.ts");
    expect(serializeEditor(editor, true)).toContain("@terminal:session-1");
    expect(serializeEditor(editor, true)).toContain("/private");
    expect(serializeEditor(editor, true, false, new Set())).toBe("Please check  and  with ");
  });
});
