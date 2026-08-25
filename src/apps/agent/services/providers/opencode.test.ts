/**
 * OpenCode Go — which wire each model answers on.
 *
 * The values asserted here are not opinions. They come from OpenCode's own
 * endpoint table and were confirmed against the live plan: `glm-5.2` answers
 * 500 on anything but chat completions, `gpt-5.6-luna` answers 500 on anything
 * but responses, and `qwen3.7-plus` answers 401 on responses with
 * `Model … is not supported for format openai`.
 *
 * The fallback cases matter as much as the table. The plan served six models
 * the documentation did not list when this was written, so a new id has to land
 * somewhere sensible rather than on a fixed default.
 */

import { describe, expect, it } from "vitest";

import {
  defaultOpenCodeWire,
  openCodeWireFor,
  OPENCODE_WIRES,
} from "@/apps/agent/services/providers/opencode";

describe("defaultOpenCodeWire", () => {
  it("sends the documented responses models to responses", () => {
    expect(defaultOpenCodeWire("grok-4.5")).toBe("opencode-go");
    expect(defaultOpenCodeWire("gpt-5.6-luna")).toBe("opencode-go");
    expect(defaultOpenCodeWire("muse-spark-1.2-contributor")).toBe("opencode-go");
  });

  it("sends every MiniMax and Qwen id to messages", () => {
    expect(defaultOpenCodeWire("minimax-m3")).toBe("opencode-go-messages");
    expect(defaultOpenCodeWire("qwen3.7-plus")).toBe("opencode-go-messages");
    expect(defaultOpenCodeWire("qwen3.8-max")).toBe("opencode-go-messages");
  });

  it("sends the chat-completions families to chat", () => {
    expect(defaultOpenCodeWire("glm-5.2")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("kimi-k3")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("deepseek-v4-pro")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("hy3")).toBe("opencode-go-chat");
  });

  it("does not put the default model on a wire that answers 500", () => {
    // The specific regression: the preset shipped `glm-5.2` on the Responses
    // wire, so a correct key on a fresh install failed its first turn.
    expect(defaultOpenCodeWire("glm-5.2")).not.toBe("opencode-go");
  });

  it("guesses undocumented ids from their family", () => {
    // All six were live on the plan and absent from the docs table.
    expect(defaultOpenCodeWire("qwen3.5-plus")).toBe("opencode-go-messages");
    expect(defaultOpenCodeWire("glm-5")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("kimi-k2.5")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("mimo-v2-pro")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("mimo-v2-omni")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("hy3-preview")).toBe("opencode-go-chat");
  });

  it("treats a free tier as the same model", () => {
    expect(defaultOpenCodeWire("ox-alpha-free")).toBe("opencode-go-chat");
    expect(defaultOpenCodeWire("gpt-5.6-luna-free")).toBe("opencode-go");
  });

  it("falls back to chat for an id from no known family", () => {
    expect(defaultOpenCodeWire("something-new-1")).toBe("opencode-go-chat");
  });
});

describe("openCodeWireFor", () => {
  it("uses the model's own default when nothing is set", () => {
    expect(openCodeWireFor({ modelKey: "glm-5.2" })).toBe("opencode-go-chat");
  });

  it("honours an override, even against the documented wire", () => {
    // The whole point of the control: the table can be wrong or out of date,
    // and the user is the one looking at the error.
    expect(
      openCodeWireFor({ modelKey: "glm-5.2", providerType: "opencode-go-messages" }),
    ).toBe("opencode-go-messages");
  });

  it("ignores a stored value that is not one of the three wires", () => {
    // Rows carry other provider types historically; one arriving here should
    // resolve to the model's default rather than be sent as-is.
    expect(openCodeWireFor({ modelKey: "qwen3.7-plus", providerType: "openai" })).toBe(
      "opencode-go-messages",
    );
    expect(openCodeWireFor({ modelKey: "glm-5.2", providerType: null })).toBe(
      "opencode-go-chat",
    );
  });
});

describe("OPENCODE_WIRES", () => {
  it("offers exactly the three wires the endpoint answers on", () => {
    expect(OPENCODE_WIRES.map((w) => w.value).sort()).toEqual([
      "opencode-go",
      "opencode-go-chat",
      "opencode-go-messages",
    ]);
  });

  it("can render every wire the resolver can produce", () => {
    // A resolved wire with no entry here would draw a picker with nothing
    // selected, which reads as a broken control rather than a set one.
    const offered = new Set(OPENCODE_WIRES.map((w) => w.value));
    for (const id of ["glm-5.2", "qwen3.7-plus", "gpt-5.6-luna", "something-new-1"]) {
      expect(offered.has(defaultOpenCodeWire(id))).toBe(true);
    }
  });
});
