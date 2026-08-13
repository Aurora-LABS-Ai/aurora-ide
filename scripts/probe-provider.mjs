#!/usr/bin/env node
/**
 * Probe a provider by running Aurora's agent loop against it — WITHOUT Aurora.
 *
 * When the transcript shows something strange (stray "..." rows between tool
 * cards, an empty reply, a turn that stalls), the first question is always the
 * same: is that the model, the gateway, or us? Reading the session JSONL tells
 * you what was stored, never who produced it. This drives the same shape of
 * conversation straight at the endpoint and prints the RAW blocks that come
 * back, so the answer is a wire observation instead of a theory.
 *
 * It replays a realistic loop rather than a single question, because the
 * behaviours worth probing show up several tool calls deep. Tool results are
 * synthetic — the point is the block sequence the model returns, not the work.
 *
 *   node scripts/probe-provider.mjs --key sk-… --url https://api.example.com/v1 \
 *     --model claude-opus-5 --style anthropic --turns 8
 *
 * Flags (all optional except the key, which may also come from PROVIDER_KEY):
 *   --url      base URL, with or without /v1        default https://api.a6api.com/v1
 *   --model    model id                             default claude-opus-5
 *   --style    anthropic | openai                   default anthropic
 *   --turns    how many loop iterations to run      default 8
 *   --thinking enable extended thinking (anthropic) default off
 *   --raw      dump each full response body too     default off
 *
 * Reports per turn: which block types came back, any text block that is only
 * filler ("...", "…", a bare newline), and a summary at the end. Exit code 1
 * when filler was seen, so it can gate a check.
 */

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = args[at + 1];
  return next && !next.startsWith("--") ? next : true;
};

const KEY = flag("key") ?? process.env.PROVIDER_KEY;
const BASE = String(flag("url", "https://api.a6api.com/v1")).replace(/\/+$/, "");
const MODEL = String(flag("model", "claude-opus-5"));
const STYLE = String(flag("style", "anthropic"));
const TURNS = Number(flag("turns", 8));
const THINKING = flag("thinking", false) !== false;
const RAW = flag("raw", false) !== false;

if (!KEY) {
  console.error("A key is required: --key sk-… (or set PROVIDER_KEY).");
  process.exit(2);
}

/** Text that says nothing — the thing we are hunting. Mirrors `isSilentContent`. */
const isFiller = (text) => text.replace(/[\s.…\-–—_*]/g, "") === "";

/** Two tools, enough to make the model choose and keep choosing. */
const TOOLS = [
  {
    name: "file_read",
    description: "Read a file from the workspace.",
    parameters: { path: "string" },
  },
  {
    name: "file_write",
    description: "Write a file in the workspace.",
    parameters: { path: "string", content: "string" },
  },
];

const anthropicTools = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(t.parameters).map(([k, v]) => [k, { type: v }]),
    ),
    required: Object.keys(t.parameters).slice(0, 1),
  },
}));

const openaiTools = TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(t.parameters).map(([k, v]) => [k, { type: v }]),
      ),
      required: Object.keys(t.parameters).slice(0, 1),
    },
  },
}));

const TASK =
  "Add a `Farm` type to the app. Work through it step by step, one tool call at " +
  "a time: read a file, then write the next one, and keep going until it is done. " +
  "Do not stop to ask me anything.";

async function callAnthropic(messages) {
  const body = {
    model: MODEL,
    max_tokens: 2048,
    tools: anthropicTools,
    messages,
    ...(THINKING
      ? { thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 1 }
      : {}),
  };
  const res = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return {
    raw: data,
    blocks: (data.content ?? []).map((b) =>
      b.type === "text"
        ? { kind: "text", text: b.text ?? "" }
        : b.type === "tool_use"
          ? { kind: "tool_use", name: b.name, id: b.id, input: b.input }
          : { kind: b.type },
    ),
    stop: data.stop_reason,
  };
}

async function callOpenAI(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, tools: openaiTools, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const msg = data.choices?.[0]?.message ?? {};
  const blocks = [];
  if (msg.reasoning_content) blocks.push({ kind: "reasoning" });
  if (msg.content) blocks.push({ kind: "text", text: msg.content });
  for (const call of msg.tool_calls ?? []) {
    blocks.push({
      kind: "tool_use",
      name: call.function?.name,
      id: call.id,
      input: call.function?.arguments,
    });
  }
  return { raw: data, blocks, stop: data.choices?.[0]?.finish_reason };
}

const call = STYLE === "openai" ? callOpenAI : callAnthropic;

/** Append the assistant turn + a synthetic result for every tool it called. */
function advance(messages, result) {
  const calls = result.blocks.filter((b) => b.kind === "tool_use");
  if (STYLE === "openai") {
    messages.push({
      role: "assistant",
      content: result.blocks.find((b) => b.kind === "text")?.text ?? null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}) },
      })),
    });
    for (const c of calls) {
      messages.push({ role: "tool", tool_call_id: c.id, content: '{"ok":true,"lines":42}' });
    }
  } else {
    messages.push({ role: "assistant", content: result.raw.content });
    messages.push({
      role: "user",
      content: calls.map((c) => ({
        type: "tool_result",
        tool_use_id: c.id,
        content: '{"ok":true,"lines":42}',
      })),
    });
  }
  return calls.length;
}

console.log(`probing ${BASE} · ${MODEL} · ${STYLE} style · ${TURNS} turns` +
  (THINKING ? " · thinking on" : ""));

const messages = [{ role: "user", content: TASK }];
let fillerTurns = 0;
let totalCalls = 0;

for (let turn = 1; turn <= TURNS; turn++) {
  let result;
  try {
    result = await call(messages);
  } catch (error) {
    console.log(`\nturn ${turn}: ${error.message}`);
    break;
  }

  const shape = result.blocks
    .map((b) => (b.kind === "text" ? `text(${b.text.length})` : b.kind === "tool_use" ? `tool_use:${b.name}` : b.kind))
    .join(" | ");
  const filler = result.blocks.filter((b) => b.kind === "text" && b.text && isFiller(b.text));
  if (filler.length) fillerTurns++;

  console.log(`\nturn ${turn}  stop=${result.stop}`);
  console.log(`  blocks: ${shape || "(none)"}`);
  for (const b of filler) {
    console.log(`  FILLER TEXT BLOCK: ${JSON.stringify(b.text)}  <-- says nothing, renders as a row`);
  }
  if (RAW) console.log(`  raw: ${JSON.stringify(result.raw).slice(0, 900)}`);

  const calls = advance(messages, result);
  totalCalls += calls;
  if (calls === 0) {
    console.log("  (no tool calls — the loop ends here)");
    break;
  }
}

console.log(
  `\n${fillerTurns} of the turns carried a filler-only text block; ${totalCalls} tool calls total.`,
);
if (fillerTurns > 0) {
  console.log(
    "That text comes from the provider, not from Aurora — the transcript renders what it is sent.",
  );
}
process.exit(fillerTurns > 0 ? 1 : 0);
