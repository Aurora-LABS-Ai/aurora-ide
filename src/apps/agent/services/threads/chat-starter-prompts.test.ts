import { describe, expect, it } from "vitest";

import { CHAT_STARTER_PROMPTS } from "@/apps/agent/services/threads/chat-starter-prompts";

describe("Aurora Chat's starter prompts", () => {
  it("offers four, each with its own kind", () => {
    expect(CHAT_STARTER_PROMPTS).toHaveLength(4);
    const kinds = CHAT_STARTER_PROMPTS.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  // The failure this prevents: a row the user clicks that sends Aurora after
  // something it has no tool for, which reads as the product being broken
  // rather than as the row being wrong.
  it("asks for nothing this side of the app cannot do", () => {
    for (const starter of CHAT_STARTER_PROMPTS) {
      const text = `${starter.title} ${starter.prompt}`.toLowerCase();
      for (const machineWord of [
        "file",
        "folder",
        "repo",
        "codebase",
        "workspace",
        "terminal",
        "shell",
        "command",
        "test",
      ]) {
        expect(text).not.toContain(machineWord);
      }
    }
  });

  // The draft lands in the composer with the caret at the end, so a starter is
  // an opening the user finishes — not a whole request, which is what a
  // workspace starter can be because the project supplies the subject.
  it("leaves the subject to the user", () => {
    for (const starter of CHAT_STARTER_PROMPTS) {
      expect(starter.prompt.endsWith(": ")).toBe(true);
      expect(starter.title.endsWith(":")).toBe(false);
    }
  });
});
