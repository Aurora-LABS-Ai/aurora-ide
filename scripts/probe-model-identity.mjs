#!/usr/bin/env node
/**
 * Ask every model on a gateway who it is, and check the wire against the answer.
 *
 * A reseller gateway can advertise a model it does not serve. The cheap tells are
 * all on the wire, not in the prose: the `model` field the response echoes back,
 * the shape of the response `id` (`chatcmpl-…` from an OpenAI-compatible server,
 * `gen-…` from OpenRouter, provider-specific prefixes elsewhere), whether a
 * thinking model actually returns `reasoning_content`, and how the token counts
 * are named. This asks the identity question AND prints those, so "the model says
 * it is Claude" and "the endpoint served something else" stay separate facts.
 *
 *   node scripts/probe-model-identity.mjs --key sk-… \
 *     --url https://api.openstarry.com/v1 \
 *     --models kimi-k3,glm-5.2,glm-5.3
 *
 * Flags (all optional except the key, which may also come from PROVIDER_KEY):
 *   --url      base URL, with or without /v1   default https://api.openstarry.com/v1
 *   --models   comma-separated model ids       default the six under test
 *   --repeat   asks per model                  default 1 (2+ catches a router that
 *                                              answers differently each call)
 *   --prompt   ask something else entirely     default the four identity questions
 *   --max-tokens  output cap                   default 700
 *   --reasoning  print the reasoning trace     default off (length only)
 *   --raw      dump each full response body    default off
 *
 * Exit code 1 when any model errored, returned nothing, or echoed back a model id
 * that is not the one asked for.
 */

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = args[at + 1];
  return next && !next.startsWith("--") ? next : true;
};

const KEY = flag("key") ?? process.env.PROVIDER_KEY ?? process.env.OPENSTARRY_KEY;
const BASE = String(flag("url", "https://api.openstarry.com/v1")).replace(/\/+$/, "");
const MAX_TOKENS = Number(flag("max-tokens", 700));
const REPEAT = Math.max(1, Number(flag("repeat", 1)));
const RAW = flag("raw", false) !== false;
const SHOW_REASONING = flag("reasoning", false) !== false;

const DEFAULT_MODELS = [
  "kimi-k3",
  "glm-5.2",
  "glm-5.3",
  "qwen3.8-max",
  "deepseek-v4-pro-0813",
  "MiniMax-M3",
];
const MODELS = String(flag("models", DEFAULT_MODELS.join(",")))
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

if (!KEY) {
  console.error("A key is required: --key sk-… (or set PROVIDER_KEY).");
  process.exit(2);
}

/**
 * Four questions, numbered, so a short answer can still be scored line by line.
 * Numbered because an unstructured "who are you" invites a paragraph of brand
 * copy that says nothing checkable.
 */
const IDENTITY_PROMPT = [
  "Answer these four questions about yourself, one short line each, numbered.",
  "Do not add anything else.",
  "1. What model are you? Give the name and version you were released under.",
  "2. Which lab or company trained you?",
  "3. What is your exact API model identifier, if you know it?",
  "4. What is your training data cutoff date?",
].join("\n");

/** `--prompt` swaps the question without touching any of the wire reporting. */
const PROMPT = typeof flag("prompt") === "string" ? String(flag("prompt")) : IDENTITY_PROMPT;

/** Cheap heuristics — which lab's name shows up in the prose. */
const LABS = [
  ["Moonshot / Kimi", /moonshot|kimi/i],
  ["Zhipu / Z.ai (GLM)", /zhipu|z\.ai|智谱|\bglm\b/i],
  ["Alibaba (Qwen)", /alibaba|qwen|tongyi|通义/i],
  ["DeepSeek", /deepseek/i],
  ["MiniMax", /minimax|abab/i],
  ["OpenAI", /openai|chatgpt|\bgpt-?[0-9]/i],
  ["Anthropic", /anthropic|claude/i],
  ["Google", /google|gemini|deepmind/i],
  ["Meta", /\bmeta\b|llama/i],
  ["xAI", /\bxai\b|grok/i],
  ["Mistral", /mistral/i],
];

const labsMentioned = (text) => LABS.filter(([, re]) => re.test(text)).map(([name]) => name);

/** What the response id looks like tells you what served it. */
const idFamily = (id) => {
  if (!id) return "(no id)";
  if (/^chatcmpl-/.test(id)) return "chatcmpl-… (OpenAI-shaped)";
  if (/^gen-/.test(id)) return "gen-… (OpenRouter-shaped)";
  if (/^msg_/.test(id)) return "msg_… (Anthropic-shaped)";
  const prefix = String(id).split(/[-_]/)[0];
  return `${prefix}-… (custom)`;
};

async function ask(model) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
  } catch (error) {
    return { error: `network: ${error.message}`, ms: Date.now() - startedAt };
  }

  const body = await res.text();
  const ms = Date.now() - startedAt;
  if (!res.ok) return { error: `HTTP ${res.status}: ${body.slice(0, 400)}`, ms };

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: `unparseable body: ${body.slice(0, 200)}`, ms };
  }

  const message = data.choices?.[0]?.message ?? {};
  return {
    ms,
    raw: data,
    echoedModel: data.model ?? null,
    id: data.id ?? null,
    fingerprint: data.system_fingerprint ?? null,
    finish: data.choices?.[0]?.finish_reason ?? null,
    text: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    usage: data.usage ?? null,
  };
}

const indent = (text, pad = "    ") =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => pad + line)
    .join("\n");

console.log(`asking ${MODELS.length} model(s) at ${BASE} who they are` +
  (REPEAT > 1 ? ` · ${REPEAT} asks each` : ""));

const rows = [];
let failures = 0;

for (const model of MODELS) {
  console.log(`\n${"=".repeat(72)}\n${model}`);
  const answers = [];

  for (let attempt = 1; attempt <= REPEAT; attempt++) {
    const result = await ask(model);

    if (result.error) {
      failures++;
      console.log(`  ask ${attempt}: FAILED after ${result.ms}ms — ${result.error}`);
      rows.push({ model, echoed: "—", labs: "—", note: result.error.slice(0, 60) });
      continue;
    }

    const labs = labsMentioned(`${result.text}\n${result.reasoning}`);
    const mismatch = result.echoedModel && result.echoedModel !== model;
    if (mismatch || !result.text.trim()) failures++;
    answers.push({ labs, echoed: result.echoedModel });

    console.log(
      `  ask ${attempt}: ${result.ms}ms · finish=${result.finish}` +
        ` · id=${idFamily(result.id)}` +
        (result.fingerprint ? ` · fingerprint=${result.fingerprint}` : ""),
    );
    console.log(
      `  echoed model: ${result.echoedModel ?? "(none)"}` +
        (mismatch ? `   <-- ASKED FOR ${model}` : ""),
    );
    if (result.usage) {
      const u = result.usage;
      console.log(
        `  usage: prompt=${u.prompt_tokens ?? "?"} completion=${u.completion_tokens ?? "?"}` +
          ` total=${u.total_tokens ?? "?"}` +
          (u.completion_tokens_details?.reasoning_tokens
            ? ` reasoning=${u.completion_tokens_details.reasoning_tokens}`
            : ""),
      );
    }
    console.log(
      `  reasoning_content: ${result.reasoning ? `${result.reasoning.length} chars` : "none"}`,
    );
    if (SHOW_REASONING && result.reasoning) console.log(indent(result.reasoning, "    | "));
    console.log(`  labs named: ${labs.length ? labs.join(", ") : "(none)"}`);
    console.log(`  answer:\n${result.text.trim() ? indent(result.text) : "    (empty)"}`);
    if (RAW) console.log(`  raw: ${JSON.stringify(result.raw).slice(0, 1200)}`);
  }

  if (answers.length) {
    const labSets = new Set(answers.map((a) => a.labs.join("+")));
    rows.push({
      model,
      echoed: answers[0].echoed ?? "(none)",
      labs: answers[0].labs.join(", ") || "(none)",
      note: labSets.size > 1 ? "answers differ between asks" : "",
    });
  }
}

console.log(`\n${"=".repeat(72)}\nsummary`);
const width = (key) => Math.max(...rows.map((r) => String(r[key]).length), key.length);
const [wm, we, wl] = [width("model"), width("echoed"), width("labs")];
console.log(
  `  ${"model".padEnd(wm)}  ${"echoed".padEnd(we)}  ${"labs".padEnd(wl)}  note`,
);
for (const r of rows) {
  console.log(
    `  ${String(r.model).padEnd(wm)}  ${String(r.echoed).padEnd(we)}  ${String(r.labs).padEnd(wl)}  ${r.note}`,
  );
}

console.log(
  failures
    ? `\n${failures} problem(s): an error, an empty answer, or a model id the endpoint changed.`
    : "\nEvery model answered and echoed back the id it was asked for.",
);
process.exit(failures ? 1 : 0);
