import { beforeEach, describe, expect, it } from "vitest";

import {
  composerImages,
  composerKey,
  useAgentAttachmentStore,
} from "./useAgentAttachmentStore";
import { composerCommands, useAgentCommandStore } from "./useAgentCommandStore";
import type { PromptCommand } from "../adapters/prompt-commands";

const image = (id: string) => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  base64: "AAAA",
});

const command = (key: string): PromptCommand =>
  ({ key, kind: "skill", title: key }) as PromptCommand;

describe("composerKey", () => {
  it("files a chat under its thread and a new chat under 'draft'", () => {
    expect(composerKey("t-1")).toBe("t-1");
    expect(composerKey(null)).toBe("draft");
    expect(composerKey(undefined)).toBe("draft");
    // An empty thread id is no thread, not a composer named "".
    expect(composerKey("")).toBe("draft");
  });
});

describe("per-composer image staging", () => {
  beforeEach(() => useAgentAttachmentStore.setState({ byComposer: {} }));

  /** The reason this store is keyed at all: the window can show two composers
   *  at once, and neither may consume what the other staged. */
  it("keeps two composers' attachments apart", () => {
    const { add } = useAgentAttachmentStore.getState();
    add("draft", image("a"));
    add("t-9", image("b"));

    const state = useAgentAttachmentStore.getState();
    expect(composerImages(state, "draft").map((i) => i.id)).toEqual(["a"]);
    expect(composerImages(state, "t-9").map((i) => i.id)).toEqual(["b"]);
  });

  it("clears only the composer that sent", () => {
    const { add, clear } = useAgentAttachmentStore.getState();
    add("draft", image("a"));
    add("t-9", image("b"));
    clear("t-9");

    const state = useAgentAttachmentStore.getState();
    expect(composerImages(state, "draft")).toHaveLength(1);
    expect(composerImages(state, "t-9")).toHaveLength(0);
  });

  it("reports the same empty array for an unstaged composer", () => {
    const state = useAgentAttachmentStore.getState();
    // Referential stability — a fresh array here would re-render every
    // composer that has nothing staged, on every unrelated store write.
    expect(composerImages(state, "nobody")).toBe(composerImages(state, "someone-else"));
  });

  it("removes and updates within one composer only", () => {
    const { add, remove, update } = useAgentAttachmentStore.getState();
    add("t-1", image("a"));
    add("t-1", image("b"));
    add("t-2", image("a"));

    remove("t-1", "a");
    update("t-1", "b", { base64: "ZZZZ", mediaType: "image/webp" });

    const state = useAgentAttachmentStore.getState();
    expect(composerImages(state, "t-1")).toEqual([
      { id: "b", name: "b.png", mediaType: "image/webp", base64: "ZZZZ" },
    ]);
    // The same id in another composer is a different attachment.
    expect(composerImages(state, "t-2").map((i) => i.id)).toEqual(["a"]);
  });
});

describe("per-composer directive staging", () => {
  beforeEach(() => useAgentCommandStore.setState({ byComposer: {} }));

  it("keeps two composers' `/` directives apart", () => {
    const { add } = useAgentCommandStore.getState();
    add("draft", command("skill:a"));
    add("t-9", command("skill:b"));

    const state = useAgentCommandStore.getState();
    expect(composerCommands(state, "draft").map((c) => c.key)).toEqual(["skill:a"]);
    expect(composerCommands(state, "t-9").map((c) => c.key)).toEqual(["skill:b"]);
  });

  it("dedupes within a composer but not across them", () => {
    const { add } = useAgentCommandStore.getState();
    add("t-1", command("skill:a"));
    add("t-1", command("skill:a"));
    add("t-2", command("skill:a"));

    const state = useAgentCommandStore.getState();
    expect(composerCommands(state, "t-1")).toHaveLength(1);
    expect(composerCommands(state, "t-2")).toHaveLength(1);
  });

  it("clears only the composer that sent", () => {
    const { add, clear } = useAgentCommandStore.getState();
    add("draft", command("skill:a"));
    add("t-9", command("skill:b"));
    clear("draft");

    const state = useAgentCommandStore.getState();
    expect(composerCommands(state, "draft")).toHaveLength(0);
    expect(composerCommands(state, "t-9")).toHaveLength(1);
  });
});
