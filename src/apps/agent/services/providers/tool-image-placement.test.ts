import { describe, expect, it } from "vitest";
import { offersToolImagePlacement, toolImageWire } from "./tool-image-placement";

const vision = (modelKey: string, providerType?: string) => ({
  modelKey,
  providerType,
  supportsVision: true,
});

describe("toolImageWire", () => {
  it("follows the Rust factory's wire for every family", () => {
    expect(toolImageWire("modal")).toBe("chat");
    expect(toolImageWire("deepseek")).toBe("chat");
    expect(toolImageWire("openai")).toBe("chat");
    expect(toolImageWire(undefined)).toBe("chat");
    expect(toolImageWire("modal-responses")).toBe("responses");
    expect(toolImageWire("deepseek-responses")).toBe("responses");
    expect(toolImageWire("ark-responses")).toBe("responses");
    expect(toolImageWire("meta-responses")).toBe("responses");
    expect(toolImageWire("modal-messages")).toBe("messages");
    expect(toolImageWire("ark-messages")).toBe("messages");
    expect(toolImageWire("meta-messages")).toBe("messages");
    expect(toolImageWire("anthropic-api")).toBe("messages");
    expect(toolImageWire("codex")).toBe("native");
    expect(toolImageWire("claude-code")).toBe("native");
    expect(toolImageWire("cursor")).toBe("native");
  });
});

describe("offersToolImagePlacement", () => {
  it("shows on a Chat or Responses provider with a vision model", () => {
    expect(offersToolImagePlacement({ providerType: "modal-responses" }, [vision("kimi")])).toBe(true);
    expect(offersToolImagePlacement({ providerType: "deepseek" }, [vision("deepseek-flash")])).toBe(true);
  });

  it("hides on Messages and native wires", () => {
    expect(offersToolImagePlacement({ providerType: "modal-messages" }, [vision("kimi")])).toBe(false);
    expect(offersToolImagePlacement({ providerType: "anthropic-api" }, [vision("claude")])).toBe(false);
    expect(offersToolImagePlacement({ providerType: "codex" }, [vision("gpt")])).toBe(false);
  });

  it("hides when no model on the provider has vision", () => {
    expect(
      offersToolImagePlacement({ providerType: "openai" }, [
        { modelKey: "m", providerType: undefined, supportsVision: false },
      ]),
    ).toBe(false);
  });

  it("reads a model's own wire over the provider's", () => {
    expect(
      offersToolImagePlacement({ providerType: "anthropic" }, [vision("gpt", "openai-responses")]),
    ).toBe(true);
    expect(
      offersToolImagePlacement({ providerType: "openai" }, [vision("claude", "anthropic")]),
    ).toBe(false);
  });

  it("resolves OpenCode Go's per-model wire from the model id", () => {
    // MiniMax answers on Messages there, GPT on Responses.
    expect(offersToolImagePlacement({ providerType: "opencode-go" }, [vision("minimax-m3")])).toBe(
      false,
    );
    expect(offersToolImagePlacement({ providerType: "opencode-go" }, [vision("gpt-5.6-luna")])).toBe(
      true,
    );
  });
});
