import { describe, expect, it } from "vitest";

import { detectBrand, providerInitial } from "./provider-brands";

describe("detectBrand", () => {
  it("knows every provider Aurora ships with, by id", () => {
    // Ids are ours, so this path is exact — it survives a user renaming the row
    // or pointing it at a proxy.
    const expected: Record<string, string> = {
      anthropic: "anthropic",
      openai: "openai",
      "openai-responses": "openai",
      codex: "codex",
      deepseek: "deepseek",
      kenari: "kenari",
      glm: "zai",
      minimax: "minimax",
      fireworks: "fireworks",
      lmstudio: "lmstudio",
      ollama: "ollama",
      atlascloud: "atlascloud",
    };
    for (const [id, brand] of Object.entries(expected)) {
      expect(detectBrand({ id })).toBe(brand);
    }
  });

  it("recognises a custom provider from the URL alone", () => {
    // The case this exists for: a key pasted in with a throwaway name. The URL
    // is the real evidence of who it belongs to.
    expect(detectBrand({ name: "work key", baseUrl: "https://openrouter.ai/api/v1" }))
      .toBe("openrouter");
    expect(detectBrand({ name: "spare", baseUrl: "https://api.groq.com/openai/v1" }))
      .toBe("groq");
    expect(detectBrand({ name: "", baseUrl: "https://api.deepseek.com" }))
      .toBe("deepseek");
    expect(detectBrand({ name: "", baseUrl: "https://api.mistral.ai/v1" }))
      .toBe("mistral");
  });

  it("recognises a custom provider from the name alone", () => {
    // The mirror case: a private or self-hosted endpoint where only the name
    // says which model family is behind it.
    expect(detectBrand({ name: "Perplexity", baseUrl: "http://10.0.0.4:8080/v1" }))
      .toBe("perplexity");
    expect(detectBrand({ name: "My Ollama box", baseUrl: "http://192.168.1.9:11434/v1" }))
      .toBe("ollama");
  });

  it("matches a name whether or not it is written as one word", () => {
    for (const name of ["LM Studio", "lmstudio", "lm-studio"]) {
      expect(detectBrand({ name, baseUrl: "" })).toBe("lmstudio");
    }
  });

  it("gives Azure and OpenRouter their own marks, not OpenAI's", () => {
    // Both names contain a product built on someone else's models, and both
    // would wear the wrong company's logo if the table were ordered by
    // convenience instead of specificity.
    expect(detectBrand({ name: "Azure OpenAI", baseUrl: "https://x.openai.azure.com" }))
      .toBe("azure");
    expect(detectBrand({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }))
      .toBe("openrouter");
    // …while a real OpenAI row is still OpenAI.
    expect(detectBrand({ name: "", baseUrl: "https://api.openai.com/v1" })).toBe("openai");
  });

  it("says it does not know rather than guessing", () => {
    // A row wearing the wrong company's logo is a lie about where the key is
    // going. No match has to stay a normal, common answer.
    expect(detectBrand({ name: "My proxy", baseUrl: "https://llm.internal.corp/v1" }))
      .toBeNull();
    expect(detectBrand({ name: "", baseUrl: "http://localhost:8000/v1" })).toBeNull();
    expect(detectBrand({})).toBeNull();
  });

  it("never lets a short fragment paint every row with one logo", () => {
    // "ai" appears in half the hostnames on the internet. A two-letter match
    // would put the same mark on everything, which is worse than a letter.
    expect(detectBrand({ name: "", baseUrl: "https://api.someai.example/v1" })).toBeNull();
    expect(detectBrand({ name: "AI Gateway", baseUrl: "" })).toBeNull();
  });

  it("finds kenari on any of its three wires", () => {
    for (const providerType of ["kenari", "kenari-messages", "kenari-responses"]) {
      expect(detectBrand({ id: "kenari", providerType } as never)).toBe("kenari");
    }
    // …and by URL, for a hand-added row.
    expect(detectBrand({ name: "gateway", baseUrl: "https://kenari.id/v1" })).toBe("kenari");
  });
});

describe("providerInitial", () => {
  it("prefers the nickname, then the name", () => {
    expect(providerInitial({ nickname: "Claude", name: "Anthropic" })).toBe("C");
    expect(providerInitial({ name: "deepseek" })).toBe("D");
  });

  it("never renders empty", () => {
    // The fallback is the last line of defence; a blank tile reads as a
    // rendering bug.
    expect(providerInitial({})).toBe("?");
    expect(providerInitial({ name: "   " })).toBe("?");
  });
});
