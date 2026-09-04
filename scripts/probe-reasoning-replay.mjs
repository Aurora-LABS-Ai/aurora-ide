#!/usr/bin/env node
/**
 * Ask an OpenAI-shaped endpoint two questions it never answers in words:
 *
 *   1. Does it ACCEPT `reasoning_content` replayed on an assistant message,
 *      or reject the request (Fireworks: "Extra inputs are not permitted")?
 *   2. If it accepts, does it FORWARD that field to the model, or swallow it?
 *
 * Question 2 is the one that matters and the one no error code answers. A
 * gateway that strips the field returns 200 either way, so Aurora reads the
 * silence as consent and the model quietly re-derives its own reasoning every
 * tool call. The only witness is the bill: send the identical conversation
 * twice, once with a large `reasoning_content` on the assistant turn and once
 * without, and compare `usage.prompt_tokens`. If the number climbs by roughly
 * the size of the block, it was forwarded. If it does not move, it was
 * dropped before it reached the model.
 *
 * Also reports cache telemetry (`prompt_cache_hit_tokens`, the DeepSeek key,
 * and `prompt_tokens_details.cached_tokens`, the OpenAI one) and re-sends one
 * request unchanged to see whether a warm prefix reads back as a hit.
 *
 *   KENARI_KEY=kn-… node scripts/probe-reasoning-replay.mjs \
 *     --url https://kenari.id/v1 --model deepseek-v4-pro
 *
 * `--style anthropic` asks the same question of an Anthropic-shaped endpoint,
 * where prior reasoning rides as a `thinking` block with a signature rather
 * than a `reasoning_content` string. The test is identical — a large block
 * that costs nothing was never forwarded — because no error distinguishes a
 * gateway that relays thinking from one that drops it.
 *
 * Flags (all optional except the key, which may also come from PROVIDER_KEY):
 *   --url     base URL, with or without /v1   default https://kenari.id/v1
 *   --model   model id                        default deepseek-v4-pro
 *   --style   openai | anthropic              default openai
 *   --filler  approx tokens of reasoning      default 4000
 *   --raw     dump each full response body    default off
 *
 * Exits 1 when replay is accepted but not forwarded — the silent-drop case.
 */

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = args[at + 1];
  return next && !next.startsWith("--") ? next : true;
};

const KEY = flag("key") ?? process.env.KENARI_KEY ?? process.env.PROVIDER_KEY;
const BASE = String(flag("url", "https://kenari.id/v1")).replace(/\/+$/, "");
const MODEL = String(flag("model", "deepseek-v4-pro"));
const FILLER_TOKENS = Number(flag("filler", 4000));
const STYLE = String(flag("style", "openai")).toLowerCase();
const RAW = flag("raw", false) !== false;

if (STYLE !== "openai" && STYLE !== "anthropic") {
  console.error(`--style must be "openai" or "anthropic", got "${STYLE}".`);
  process.exit(2);
}

if (!KEY) {
  console.error("A key is required: --key kn-… (or set KENARI_KEY).");
  process.exit(2);
}

/**
 * Reasoning filler with no repetition a cache or compressor could collapse,
 * and no instruction the model might act on. Roughly one token per word.
 */
const reasoningFiller = (tokens) => {
  const words = [];
  let seed = 1337;
  for (let i = 0; i < tokens; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    words.push(`step${seed % 100000}`);
  }
  return `I considered the following intermediate states: ${words.join(" ")}.`;
};

const FILLER = reasoningFiller(FILLER_TOKENS);

/**
 * One realistic mid-loop conversation: a tool call already made, its result
 * already back, and a follow-up question. `withReasoning` decides whether the
 * assistant turn carries its own prior thinking.
 */
const conversation = (withReasoning) => {
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_probe_0001",
        type: "function",
        function: { name: "file_read", arguments: '{"path":"README.md"}' },
      },
    ],
  };
  if (withReasoning) assistant.reasoning_content = FILLER;
  return [
    { role: "system", content: "You are a coding agent. Answer in one short sentence." },
    { role: "user", content: "Read README.md and tell me what this project is." },
    assistant,
    { role: "tool", tool_call_id: "call_probe_0001", content: "# Widget\n\nA small widget library.\n" },
    { role: "user", content: "Now say what language it is in." },
  ];
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

/**
 * The same mid-loop conversation in Anthropic's shape. Prior reasoning is a
 * `thinking` block carrying a signature, so the assistant turn is a content
 * array rather than a `reasoning_content` string beside one.
 */
const anthropicConversation = (withReasoning) => {
  const assistantBlocks = [];
  if (withReasoning) {
    assistantBlocks.push({ type: "thinking", thinking: FILLER, signature: "probe-signature" });
  }
  assistantBlocks.push({
    type: "tool_use",
    id: "call_probe_0001",
    name: "file_read",
    input: { path: "README.md" },
  });
  return [
    { role: "user", content: [{ type: "text", text: "Read README.md and tell me what this project is." }] },
    { role: "assistant", content: assistantBlocks },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_probe_0001", content: "# Widget\n\nA small widget library.\n" },
        { type: "text", text: "Now say what language it is in." },
      ],
    },
  ];
};

async function call(label, messages) {
  const anthropic = STYLE === "anthropic";
  const body = anthropic
    ? {
        model: MODEL,
        max_tokens: 64,
        system: [{ type: "text", text: "You are a coding agent. Answer in one short sentence." }],
        messages,
        tools: TOOLS.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        })),
        stream: false,
      }
    : {
        model: MODEL,
        messages,
        tools: TOOLS,
        max_tokens: 64,
        stream: false,
      };
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/${anthropic ? "messages" : "chat/completions"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(anthropic ? { "anthropic-version": "2023-06-01", "x-api-key": KEY } : {}),
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { label, error: `network: ${err.message}` };
  }
  const text = await res.text();
  const ms = Date.now() - started;
  if (!res.ok) {
    return { label, status: res.status, error: text.slice(0, 400), ms };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { label, status: res.status, error: `unparseable body: ${text.slice(0, 200)}`, ms };
  }
  if (RAW) console.log(`\n--- raw ${label} ---\n${JSON.stringify(json, null, 2).slice(0, 4000)}`);
  const u = json.usage ?? {};
  if (STYLE === "anthropic") {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const thinking = blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
    return {
      label,
      status: res.status,
      ms,
      // Anthropic bills the cached prefix separately, so the comparable
      // "what did this prompt cost" number is input plus both cache counters.
      promptTokens:
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      completionTokens: u.output_tokens ?? null,
      cacheHitDeepSeek: null,
      cacheHitOpenAi: u.cache_read_input_tokens ?? null,
      usageKeys: Object.keys(u),
      returnedReasoning: thinking.reduce((n, b) => n + (b.thinking ?? b.data ?? "").length, 0),
      replyPreview: (blocks.find((b) => b.type === "text")?.text ?? "").slice(0, 80),
    };
  }
  const msg = json.choices?.[0]?.message ?? {};
  return {
    label,
    status: res.status,
    ms,
    promptTokens: u.prompt_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    cacheHitDeepSeek: u.prompt_cache_hit_tokens ?? null,
    cacheMissDeepSeek: u.prompt_cache_miss_tokens ?? null,
    cacheHitOpenAi: u.prompt_tokens_details?.cached_tokens ?? null,
    usageKeys: Object.keys(u),
    returnedReasoning: (msg.reasoning_content ?? msg.reasoning ?? "").length,
    replyPreview: (msg.content ?? "").slice(0, 80),
  };
}

const line = (r) => {
  if (r.error) return `  ${r.label.padEnd(22)} HTTP ${r.status ?? "-"}  ERROR ${r.error.replace(/\s+/g, " ").slice(0, 220)}`;
  const cache =
    r.cacheHitDeepSeek ?? r.cacheHitOpenAi ?? null;
  return (
    `  ${r.label.padEnd(22)} HTTP ${r.status}  prompt=${String(r.promptTokens).padStart(7)}` +
    `  completion=${String(r.completionTokens).padStart(5)}` +
    `  cached=${cache === null ? "  (none)" : String(cache).padStart(7)}` +
    `  reasoningBack=${String(r.returnedReasoning).padStart(6)}  ${r.ms}ms`
  );
};

(async () => {
  console.log(`Endpoint : ${BASE}`);
  console.log(`Model    : ${MODEL}`);
  console.log(`Wire     : ${STYLE === "anthropic" ? "anthropic /messages, thinking block" : "openai /chat/completions, reasoning_content"}`);
  console.log(`Filler   : ~${FILLER_TOKENS} tokens (${FILLER.length} chars) of replayed reasoning\n`);

  const shape = STYLE === "anthropic" ? anthropicConversation : conversation;
  const without = await call("no reasoning", shape(false));
  const withIt = await call("with reasoning", shape(true));
  const repeat = await call("with reasoning (2nd)", shape(true));

  console.log("Results");
  console.log(line(without));
  console.log(line(withIt));
  console.log(line(repeat));
  console.log();

  if (withIt.error) {
    console.log("VERDICT: the endpoint REJECTS replayed reasoning.");
    console.log("         Aurora should record this endpoint as refusing the field.");
    process.exit(0);
  }
  if (without.error) {
    console.log("VERDICT: inconclusive — the baseline request itself failed.");
    process.exit(2);
  }

  const delta = withIt.promptTokens - without.promptTokens;
  const ratio = delta / FILLER_TOKENS;
  console.log(`Prompt token delta: ${delta} for ~${FILLER_TOKENS} tokens of reasoning (${(ratio * 100).toFixed(0)}%)`);

  let silentDrop = false;
  if (ratio > 0.5) {
    console.log("VERDICT: reasoning_content is ACCEPTED and FORWARDED — the model sees its own");
    console.log("         earlier thinking, and it is billed as prompt. Replay is working.");
  } else if (ratio < 0.1) {
    console.log("VERDICT: reasoning_content is ACCEPTED and SILENTLY DROPPED. The request");
    console.log("         succeeds, nothing is billed, and the model never sees it. Replay is");
    console.log("         a no-op on this endpoint no matter what Aurora sends.");
    silentDrop = true;
  } else {
    console.log("VERDICT: partial — the gateway may be truncating or re-encoding the field.");
  }

  const anyCache =
    [without, withIt, repeat].some((r) => (r.cacheHitDeepSeek ?? r.cacheHitOpenAi) !== null);
  console.log();
  if (!anyCache) {
    console.log("Cache: no cache fields in any usage object. Keys seen: " +
      JSON.stringify(withIt.usageKeys));
    console.log("       Aurora reads prompt_cache_hit_tokens and prompt_tokens_details.cached_tokens;");
    console.log("       this endpoint reports neither, so hit rate is unmeasurable from usage alone.");
  } else {
    console.log(`Cache: reported. Repeat of an identical request read back ` +
      `${repeat.cacheHitDeepSeek ?? repeat.cacheHitOpenAi} cached tokens.`);
  }

  process.exit(silentDrop ? 1 : 0);
})();
