import { describe, expect, it } from "vitest";

import {
  parseWebChatPath,
  projectForSlug,
  projectSlug,
  webChatPath,
} from "@/apps/agent/lib/navigation/web-chat-url";

describe("web chat URLs", () => {
  it("names a project like the backend names its folder", () => {
    expect(projectSlug("E:\\VOID-EDITOR\\Aurora-Agent-IDE")).toBe("e--void-editor-aurora-agent-ide");
    expect(projectSlug("e:/void-editor/aurora-agent-ide/")).toBe("e--void-editor-aurora-agent-ide");
    expect(projectSlug("/home/alvan/code")).toBe("-home-alvan-code");
  });

  it("writes and reads back every location", () => {
    const cases = [
      { kind: "home" as const },
      { kind: "project" as const, slug: "e--repo", threadId: null },
      { kind: "project" as const, slug: "e--repo", threadId: "7d5db95e-f37f" },
      { kind: "chat" as const, threadId: "abc-123" },
    ];
    for (const location of cases) {
      expect(parseWebChatPath(webChatPath(location))).toEqual(location);
    }
    expect(webChatPath({ kind: "project", slug: "e--repo", threadId: "t1" })).toBe(
      "/agent-window/p/e--repo/t1",
    );
  });

  it("treats anything it does not recognise as the home screen", () => {
    expect(parseWebChatPath("/agent-window")).toEqual({ kind: "home" });
    expect(parseWebChatPath("/agent-window/")).toEqual({ kind: "home" });
    expect(parseWebChatPath("/agent-window/x/y")).toEqual({ kind: "home" });
    expect(parseWebChatPath("/agent-window/p")).toEqual({ kind: "home" });
  });

  it("matches a slug only to a project the window already knows", () => {
    const roots = ["E:\\VOID-EDITOR\\Aurora", "D:\\Other"];
    expect(projectForSlug("e--void-editor-aurora", roots)).toBe("E:\\VOID-EDITOR\\Aurora");
    expect(projectForSlug("c--windows", roots)).toBeNull();
  });
});
