#!/usr/bin/env node
/**
 * Does an Anthropic-SHAPED endpoint actually honour `cache_control`?
 *
 * `supports_prompt_caching` (provider_kernel_adapter.rs:1219) sends the marker
 * to one provider type and no other: literal `"anthropic"`. Everything else
 * speaking the same wire — kenari-messages, modal-messages, MiniMax — gets no
 * breakpoint at all. The comment is honest about why: an unknown field has
 * caused HTTP 400 storms before, so a false positive costs every request while
 * a false negative only costs money.
 *
 * That trade is only correct while the money is small. This settles it per
 * endpoint, with the two outcomes kept apart:
 *
 *   REJECTED  — the marker 400s. The allowlist is right to exclude it.
 *   IGNORED   — 200, but no cache_creation/cache_read in usage. Harmless, useless.
 *   HONOURED  — 200, and a second identical request reads tokens back. The
 *               allowlist is costing real money for no safety.
 *
 * Anthropic reports caching as two separate counters rather than a subset of
 * the prompt, so both are read: `cache_creation_input_tokens` on the write and
 * `cache_read_input_tokens` on the hit.
 *
 *   KENARI_KEY=kn-… node scripts/probe-anthropic-cache-control.mjs \
 *     --url https://kenari.id/v1 --model deepseek-v4-pro
 *
 * Flags: --url --model --key --raw
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

const bulk = (words) => {
  const out = [];
  let seed = 11;
  for (let i = 0; i < words; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push(`ctx${seed % 100000}`);
  }
  return out.join(" ");
};

// Comfortably past Anthropic's 1024-token minimum for a cacheable prefix.
const SYSTEM_TEXT = `You are a coding agent. Session ${NONCE}. Answer in one short sentence. Reference material follows: ${bulk(2000)}`;

const body = (withMarkers) => {
  const system = [{ type: "text", text: SYSTEM_TEXT }];
  if (withMarkers) system[0].cache_control = { type: "ephemeral" };

  const userContent = [{ type: "text", text: "Say the word ready." }];
  if (withMarkers) userContent[0].cache_control = { type: "ephemeral" };

  return {
    model: MODEL,
    max_tokens: 32,
    system,
    messages: [{ role: "user", content: userContent }],
    stream: false,
  };
};

async function call(label, withMarkers) {
  let res;
  try {
    res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": KEY,
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(body(withMarkers)),
    });
  } catch (err) {
    return { label, error: `network: ${err.message}` };
  }
  const text = await res.text();
  if (!res.ok) return { label, status: res.status, error: text.slice(0, 300) };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { label, status: res.status, error: `unparseable: ${text.slice(0, 200)}` };
  }
  if (RAW) console.log(`\n--- raw ${label} ---\n${JSON.stringify(json.usage, null, 2)}`);
  const u = json.usage ?? {};
  return {
    label,
    status: res.status,
    input: u.input_tokens ?? null,
    output: u.output_tokens ?? null,
    write: u.cache_creation_input_tokens ?? null,
    read: u.cache_read_input_tokens ?? null,
    keys: Object.keys(u),
  };
}

/**
 * Every SSE frame that carried a `usage` object, in arrival order, with the
 * event type that carried it. This is the only view that shows a later frame
 * contradicting an earlier one.
 */
async function streamUsageFrames(withMarkers) {
  let res;
  try {
    res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": KEY,
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ ...body(withMarkers), stream: true }),
    });
  } catch (err) {
    return { error: `network: ${err.message}` };
  }
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };

  const out = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = chunk.usage ?? chunk.message?.usage;
    if (usage) out.push({ type: chunk.type ?? "?", usage });
  }
  return out;
}

const line = (r) =>
  r.error
    ? `  ${r.label.padEnd(26)} HTTP ${r.status ?? "-"}  ERROR ${r.error.replace(/\s+/g, " ").slice(0, 200)}`
    : `  ${r.label.padEnd(26)} HTTP ${r.status}  input=${String(r.input).padStart(6)}` +
      `  cacheWrite=${String(r.write).padStart(6)}  cacheRead=${String(r.read).padStart(6)}`;

(async () => {
  console.log(`Endpoint : ${BASE}/messages`);
  console.log(`Model    : ${MODEL}`);
  console.log(`Nonce    : ${NONCE}\n`);

  const plain = await call("1 no markers", false);
  const marked = await call("2 with cache_control", true);
  const markedAgain = await call("3 with markers, repeat", true);

  // The streamed frames, in order. Anthropic sends usage more than once per
  // response — `message_start` carries the input and cache counters, later
  // frames carry the running output count. A gateway that repeats the cache
  // fields as 0 on a later frame will silently undo the first one in any
  // consumer that merges frames without a monotonic guard.
  const frames = await streamUsageFrames(true);
  console.log("Streamed usage frames (order matters)");
  if (frames.error) {
    console.log(`  stream failed: ${frames.error}`);
  } else {
    frames.forEach((f, i) =>
      console.log(`  frame ${i} · ${f.type.padEnd(15)} ${JSON.stringify(f.usage)}`),
    );
    const reads = frames
      .map((f) => f.usage?.cache_read_input_tokens)
      .filter((v) => typeof v === "number");
    if (reads.length > 1 && reads.at(-1) < Math.max(...reads)) {
      console.log(
        `\n  WARNING: cache_read_input_tokens goes ${reads.join(" -> ")}. A consumer that`,
      );
      console.log("  takes the last frame reads 0 for a response that really cached.");
    }
    console.log();
  }

  console.log("Results");
  [plain, marked, markedAgain].forEach((r) => console.log(line(r)));
  console.log();

  if (plain.error) {
    console.log("Inconclusive — the endpoint rejected even the unmarked request.");
    console.log(`  ${plain.error}`);
    process.exit(2);
  }
  if (marked.error) {
    console.log("VERDICT: REJECTED. `cache_control` makes the request fail.");
    console.log("         The allowlist is correct to keep this provider off it.");
    process.exit(0);
  }

  const wrote = (marked.write ?? 0) > 0;
  const read = (markedAgain.read ?? 0) > 0;
  if (wrote || read) {
    console.log("VERDICT: HONOURED. The endpoint accepts the marker and caches on it.");
    console.log(`         Wrote ${marked.write} tokens, read ${markedAgain.read} back on the repeat.`);
    console.log("         Adding this provider type to `supports_prompt_caching` is safe");
    console.log("         and is worth real money.");
  } else if (marked.read === null && marked.write === null) {
    console.log("VERDICT: IGNORED. Accepted with no complaint and no cache counters.");
    console.log(`         usage keys: ${JSON.stringify(marked.keys)}`);
    console.log("         Sending the marker here is harmless but buys nothing.");
  } else {
    console.log("VERDICT: accepted, counters present but zero. Either the prefix is under");
    console.log("         the minimum cacheable size, or caching is off for this key.");
  }
})();
