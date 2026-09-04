#!/usr/bin/env node
/**
 * Why a gateway that demonstrably caches reports no hits to Aurora.
 *
 * `probe-reasoning-replay.mjs` showed kenari returning
 * `prompt_tokens_details.cached_tokens` on a repeated non-streaming request —
 * the exact field Aurora reads. Yet a real 8-turn session recorded zero cache
 * reads on every turn. Something between those two observations differs, and
 * there are only two candidates worth testing:
 *
 *   A. STREAMING. Aurora streams; the first probe did not. Many gateways emit
 *      `usage` only on the closing chunk, and some emit a thinner one there.
 *   B. THE REASONING FIELD IN THE CACHE KEY. Replayed `reasoning_content`
 *      costs zero prompt tokens on this endpoint, but if it still takes part
 *      in the prefix hash then sending it turns every request into a miss —
 *      pure downside, and invisible in the token count.
 *
 * Every request here carries a fresh nonce in the system prompt so no earlier
 * run can warm it, and the sequence is ordered so each answer is unambiguous.
 *
 *   KENARI_KEY=kn-… node scripts/probe-kenari-cache.mjs
 *
 * Flags: --url, --model, --raw (as in probe-reasoning-replay.mjs)
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
const RAW = flag("raw", false) !== false;

if (!KEY) {
  console.error("A key is required: --key kn-… (or set KENARI_KEY).");
  process.exit(2);
}

const NONCE = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A prefix long enough to clear any minimum-block threshold a prefix cache
 * imposes (DeepSeek's is 64 tokens per block). Deterministic given the nonce.
 */
const bulk = (words) => {
  const out = [];
  let seed = 7;
  for (let i = 0; i < words; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push(`ctx${seed % 100000}`);
  }
  return out.join(" ");
};

const SYSTEM = `You are a coding agent. Session ${NONCE}. Answer in one short sentence. Reference material follows: ${bulk(1500)}`;
const REASONING = `I weighed these intermediate states: ${bulk(800)}.`;

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
  if (withReasoning) assistant.reasoning_content = REASONING;
  return [
    { role: "system", content: SYSTEM },
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
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

const readUsage = (u = {}) => ({
  prompt: u.prompt_tokens ?? null,
  completion: u.completion_tokens ?? null,
  cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null,
  keys: Object.keys(u),
});

async function call(label, { withReasoning, stream }) {
  const body = {
    model: MODEL,
    messages: conversation(withReasoning),
    tools: TOOLS,
    max_tokens: 48,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { label, error: `network: ${err.message}` };
  }
  const text = await res.text();
  if (!res.ok) return { label, status: res.status, error: text.slice(0, 300) };

  if (!stream) {
    const json = JSON.parse(text);
    if (RAW) console.log(`\n--- raw ${label} ---\n${JSON.stringify(json.usage, null, 2)}`);
    return { label, status: res.status, ...readUsage(json.usage) };
  }

  // Streaming: the usage we care about rides on one of the final frames.
  let usage = null;
  let frames = 0;
  let usageFrames = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    frames += 1;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.usage) {
      usageFrames += 1;
      usage = chunk.usage;
    }
  }
  if (RAW) console.log(`\n--- raw ${label} (${frames} frames, ${usageFrames} with usage) ---\n${JSON.stringify(usage, null, 2)}`);
  return { label, status: res.status, frames, usageFrames, ...readUsage(usage ?? {}) };
}

const line = (r) => {
  if (r.error) return `  ${r.label.padEnd(30)} HTTP ${r.status ?? "-"}  ERROR ${r.error.replace(/\s+/g, " ").slice(0, 180)}`;
  const extra = r.frames === undefined ? "" : `  frames=${r.frames} usageFrames=${r.usageFrames}`;
  return (
    `  ${r.label.padEnd(30)} prompt=${String(r.prompt).padStart(6)}` +
    `  cached=${r.cached === null ? " (absent)" : String(r.cached).padStart(6)}${extra}`
  );
};

(async () => {
  console.log(`Endpoint : ${BASE}`);
  console.log(`Model    : ${MODEL}`);
  console.log(`Nonce    : ${NONCE}  (nothing below can be warm from an earlier run)\n`);

  // 1. Cold, no reasoning. Establishes the prefix and the baseline size.
  const cold = await call("1 cold, no reasoning", { withReasoning: false, stream: false });
  // 2. Same body again. Proves the endpoint caches at all, and by how much.
  const warm = await call("2 repeat, no reasoning", { withReasoning: false, stream: false });
  // 3. Same conversation PLUS reasoning_content. If the field is stripped
  //    before hashing, this still hits. If it is part of the key, it misses.
  const withR = await call("3 same + reasoning_content", { withReasoning: true, stream: false });
  // 4. Back to the plain body. Confirms the prefix is still warm either way.
  const backToPlain = await call("4 plain again", { withReasoning: false, stream: false });
  // 5. The plain body over SSE. Same prefix, streamed — what Aurora does.
  const streamed = await call("5 plain, STREAMED", { withReasoning: false, stream: true });

  console.log("Results");
  [cold, warm, withR, backToPlain, streamed].forEach((r) => console.log(line(r)));
  console.log();

  if (warm.error || cold.error) {
    console.log("Inconclusive — a baseline request failed.");
    process.exit(2);
  }

  console.log("Reading");
  if ((warm.cached ?? 0) > 0) {
    console.log(`  Caching works: an identical repeat read back ${warm.cached} of ${warm.prompt} prompt tokens.`);
  } else {
    console.log("  This endpoint did NOT cache an identical repeat. Nothing else here matters.");
    process.exit(0);
  }

  if (!withR.error) {
    if ((withR.cached ?? 0) > 0) {
      console.log(`  reasoning_content does NOT break the cache (${withR.cached} cached). Sending it is`);
      console.log("  merely useless on this endpoint, not harmful.");
    } else {
      console.log("  reasoning_content BREAKS THE CACHE: same conversation, same prefix, 0 cached.");
      console.log("  It costs no prompt tokens and gives the model nothing, but it turns every");
      console.log("  request into a full-price miss. Sending it here is pure loss.");
    }
  }

  if (streamed.error) {
    console.log(`  Streaming request failed: ${streamed.error}`);
  } else if (streamed.cached === null) {
    console.log(`  STREAMING drops the cache telemetry: ${streamed.usageFrames} frame(s) carried usage,`);
    console.log(`  keys ${JSON.stringify(streamed.keys)} — no cached_tokens. Aurora streams, so it can`);
    console.log("  never see a hit here even when one happened. This is the reporting gap.");
  } else if (streamed.cached === 0 && (backToPlain.cached ?? 0) > 0) {
    console.log(`  STREAMING reports cached=0 where the same non-streamed body reported`);
    console.log(`  ${backToPlain.cached}. The streamed usage is present but not populated.`);
  } else {
    console.log(`  STREAMING reports the hit correctly (${streamed.cached} cached).`);
  }
})();
