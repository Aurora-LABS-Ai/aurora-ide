/**
 * Work out which company a provider row belongs to, from what the user typed.
 *
 * The built-in rows are easy — their ids are ours and never change. The
 * interesting case is a custom provider: someone pastes
 * `https://openrouter.ai/api/v1` and names it "work key", and the row should
 * still show OpenRouter's logo rather than a letter W.
 *
 * This module is deliberately pure — it answers "which brand is this?" with a
 * string and nothing more. Turning that answer into a picture is the UI's job
 * (`settings/ProviderAvatar.tsx`), which keeps every React import out of the
 * services layer and makes the matching itself testable without rendering.
 *
 * Matching runs over the provider's name, nickname AND base URL together,
 * because either one alone is often the only clue: a row named "gateway"
 * pointing at `api.deepseek.com` and a row named "DeepSeek" pointing at a
 * private proxy are both DeepSeek.
 */

/**
 * Every brand we can draw.
 *
 * A runtime array rather than a bare type union, so a test can walk it and
 * prove each one actually resolves to a mark. A brand that exists in the type
 * but has no picture behind it renders as nothing at all — an empty tile, which
 * reads as a broken build rather than as a missing logo.
 */
export const BRAND_KEYS = [
  "anthropic",
  "openai",
  "codex",
  "cursor",
  "opencode",
  "commandcode",
  "deepseek",
  "kenari",
  "modal",
  "zai",
  "zhipu",
  "minimax",
  "fireworks",
  "lmstudio",
  "ollama",
  "atlascloud",
  "openrouter",
  "groq",
  "together",
  "mistral",
  "cohere",
  "perplexity",
  "xai",
  "google",
  "qwen",
  "moonshot",
  "siliconcloud",
  "novita",
  "deepinfra",
  "hyperbolic",
  "cerebras",
  "sambanova",
  "nvidia",
  "azure",
  "bedrock",
  "vertex",
  "huggingface",
  "replicate",
  "meta",
  "doubao",
  "stepfun",
  "nebius",
  "vllm",
  "xinference",
] as const;

/** A brand we can draw. The value is the key `ProviderAvatar` renders. */
export type BrandKey = (typeof BRAND_KEYS)[number];

/**
 * The brand a built-in row belongs to, by provider id.
 *
 * Checked before any text matching. These ids are ours, so this mapping is
 * exact and cannot be thrown off by a user renaming a row or pointing it at a
 * proxy.
 */
const BY_ID: Readonly<Record<string, BrandKey>> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-responses": "openai",
  codex: "codex",
  cursor: "cursor",
  "opencode-go": "opencode",
  commandcode: "commandcode",
  deepseek: "deepseek",
  kenari: "kenari",
  modal: "modal",
  glm: "zai",
  minimax: "minimax",
  fireworks: "fireworks",
  lmstudio: "lmstudio",
  ollama: "ollama",
  atlascloud: "atlascloud",
};

/**
 * Words that identify a brand in a name or a URL, most specific first.
 *
 * ORDER IS LOAD-BEARING. `azure` sits above `openai` because "Azure OpenAI" is
 * Azure's product and should wear Azure's mark; `openrouter` sits above
 * `openai` for the same reason. A key is only ever matched as a whole word or
 * as a run of at least four characters, so short fragments like "ai" cannot
 * paint every row with the same logo.
 */
const DETECT: ReadonlyArray<readonly [BrandKey, readonly string[]]> = [
  ["kenari", ["kenari"]],
  // Above the vendors for the same reason Modal is: a Command Code row serves
  // Claude, GPT, GLM and Kimi, and the row belongs to Command Code rather than
  // to whichever model it resells. Both spellings, because the product is
  // written with a space and the package without one.
  ["commandcode", ["commandcode", "command code"]],
  // Above the vendors: a Modal workspace serves Kimi, GLM and DeepSeek
  // endpoints, and the row belongs to Modal, not to whichever model it hosts.
  ["modal", ["modal direct", "modal"]],
  ["openrouter", ["openrouter"]],
  ["azure", ["azure"]],
  ["bedrock", ["bedrock", "amazonaws"]],
  ["vertex", ["vertex", "vertexai", "aiplatform"]],
  ["codex", ["codex"]],
  // Above `openai` and `anthropic`: a Cursor row reaches GPT and Claude models,
  // so its name or URL can mention either, and Cursor's own mark is the honest
  // one for a row whose account is Cursor's.
  ["cursor", ["cursor"]],
  ["opencode", ["opencode", "open code"]],
  ["atlascloud", ["atlascloud", "atlas cloud"]],
  ["anthropic", ["anthropic", "claude"]],
  ["openai", ["openai", "chatgpt"]],
  ["deepseek", ["deepseek"]],
  ["zai", ["z ai", "zai", "bigmodel", "glm"]],
  ["zhipu", ["zhipu", "chatglm", "chatglm"]],
  ["minimax", ["minimax", "minimaxi"]],
  ["fireworks", ["fireworks"]],
  ["lmstudio", ["lmstudio", "lm studio"]],
  ["ollama", ["ollama"]],
  ["groq", ["groq"]],
  ["together", ["together", "togetherai"]],
  ["mistral", ["mistral", "codestral"]],
  ["cohere", ["cohere"]],
  ["perplexity", ["perplexity", "pplx"]],
  ["xai", ["xai", "x ai", "grok"]],
  ["google", ["googleapis", "google", "gemini", "generativelanguage"]],
  ["qwen", ["qwen", "dashscope", "aliyuncs"]],
  ["moonshot", ["moonshot", "kimi"]],
  ["siliconcloud", ["siliconflow", "siliconcloud"]],
  ["novita", ["novita"]],
  ["deepinfra", ["deepinfra"]],
  ["hyperbolic", ["hyperbolic"]],
  ["cerebras", ["cerebras"]],
  ["sambanova", ["sambanova"]],
  ["nvidia", ["nvidia", "nim ", "build nvidia"]],
  ["huggingface", ["huggingface", "hugging face"]],
  ["replicate", ["replicate"]],
  ["meta", ["llama", "meta ai"]],
  ["doubao", ["doubao", "volcengine", "volces"]],
  ["stepfun", ["stepfun"]],
  ["nebius", ["nebius"]],
  ["vllm", ["vllm"]],
  ["xinference", ["xinference", "xorbits"]],
];

/** The shortest run we will match inside a squashed string like "apideepseekcom". */
const MIN_LOOSE_KEY = 4;

interface Haystack {
  spaced: string;
  squashed: string;
}

/**
 * The host part of a base URL, tolerant of what people actually paste — a bare
 * host, a missing scheme, a trailing path.
 */
function hostOf(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    // Not a URL at all — fall back to the leading token, which is the host in
    // every realistic near-miss.
    return trimmed.split("/")[0] ?? "";
  }
}

function prepare(raw: string): Haystack {
  const lower = raw.toLowerCase();
  return {
    // Punctuation becomes a gap, so "z.ai" and "lm-studio" read as two words
    // and can be matched as whole words rather than as fragments.
    spaced: ` ${lower.replace(/[^a-z0-9]+/g, " ").trim()} `,
    // …and with the gaps removed, so "lm studio" also matches "lmstudio".
    squashed: lower.replace(/[^a-z0-9]+/g, ""),
  };
}

/**
 * Two rounds of evidence, strongest first.
 *
 * The HOST and the name are what identify a company. A URL PATH is not: every
 * OpenAI-compatible gateway on the internet puts `/openai/` in its path, and
 * Groq's own endpoint is `api.groq.com/openai/v1`. Matching the whole URL at
 * once made that row wear OpenAI's logo — technically a substring, completely
 * the wrong answer.
 *
 * The full string still gets a second pass, so a private gateway routed at
 * `/anthropic/v1` is not left blank when nothing stronger identified it.
 */
function rounds(provider: {
  name?: string;
  nickname?: string;
  baseUrl?: string;
}): Haystack[] {
  const named = `${provider.nickname ?? ""} ${provider.name ?? ""}`;
  const host = hostOf(provider.baseUrl ?? "");
  return [prepare(`${named} ${host}`), prepare(`${named} ${provider.baseUrl ?? ""}`)];
}

function matches(key: string, { spaced, squashed }: Haystack): boolean {
  const word = key.replace(/[^a-z0-9]+/g, " ").trim();
  if (!word) return false;
  if (spaced.includes(` ${word} `)) return true;
  const tight = word.replace(/ /g, "");
  return tight.length >= MIN_LOOSE_KEY && squashed.includes(tight);
}

/**
 * The brand behind this provider row, or `null` when nothing matches.
 *
 * `null` is a normal answer, not a failure: most self-hosted and private
 * endpoints belong to no brand at all, and a letter is the honest thing to show
 * for them. Guessing would be worse — a row wearing the wrong company's logo is
 * a lie about where the user's key is going.
 */
export function detectBrand(provider: {
  id?: string;
  name?: string;
  nickname?: string;
  baseUrl?: string;
}): BrandKey | null {
  if (provider.id && BY_ID[provider.id]) return BY_ID[provider.id];

  for (const strings of rounds(provider)) {
    for (const [brand, keys] of DETECT) {
      for (const key of keys) {
        if (matches(key, strings)) return brand;
      }
    }
  }
  return null;
}

/** The letter shown when a provider matches no brand. */
export function providerInitial(provider: { name?: string; nickname?: string }): string {
  return (provider.nickname || provider.name || "?").trim().charAt(0).toUpperCase() || "?";
}
