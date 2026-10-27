/**
 * Golden files for the provider snapshot and the model knobs a turn sends.
 *
 * `useAgentWindowSend` turns a `"providerId:modelKey"` selection into the
 * request's `providerConfig`, `model`, `temperature`, `maxOutputTokens`,
 * `contextWindow`, the thinking pair and `compactionProviderConfig`
 * (`resolveModelRequest` → `AgentRuntimeClient.buildRequest`). Phase 3.6 moves
 * that into the engine, which reads the same rows from SQLite; this records
 * the exact slice for pinned rows into
 * `src-tauri/src/agent_runtime/turn_build/golden/provider/`, with the rows and
 * the selections in `cases.json`, for the Rust port (`turn_build/provider.rs`).
 *
 * The rows are written in the DATABASE shape (what Rust serialises) and mapped
 * into the store exactly as the window maps them (`dbToProvider`,
 * `dbToModel`), so a `0` or `null` in a column lands the same on both sides.
 * The Cursor catalogue and the per-row Fast preference are pinned too.
 *
 * A deliberate change: run with `AURORA_UPDATE_GOLDEN=1` and commit the diff.
 */

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { AgentRuntimeClient, type AgentRuntimeChatInput } from "@/apps/agent/services/runtime/agent-runtime-client";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveModelRequest,
  resolveTemperature,
} from "@/apps/agent/services/runtime/model-request-config";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { dbToModel, dbToProvider } from "@/apps/agent/store/settings/provider-model";
import { primeCursorVariants } from "@/apps/agent/services/providers/cursor-variants";
import type { CursorModelView } from "@/apps/agent/services/providers/cursor";
import { CURSOR_FAST_KEY, resetFastPreferenceCache } from "@/apps/agent/lib/model/cursor-fast";

const node = (globalThis as unknown as {
  process: { cwd: () => string; env: Record<string, string | undefined> };
}).process;
const GOLDEN_DIR = `${node.cwd()}/src-tauri/src/agent_runtime/turn_build/golden/provider`;
const UPDATE = node.env.AURORA_UPDATE_GOLDEN === "1";

type DbProvider = Parameters<typeof dbToProvider>[0];
type DbModel = Parameters<typeof dbToModel>[0];

const STAMP = "2026-01-01T00:00:00.000Z";

/** A `llm_providers` row as Rust serialises it. */
const provider = (over: Partial<DbProvider> & Pick<DbProvider, "id" | "name">): DbProvider => ({
  baseUrl: `https://${over.id}.example.invalid/v1`,
  apiKey: `sk-${over.id}`,
  model: "",
  contextWindow: 128000,
  maxOutputTokens: 16384,
  supportsToolStream: false,
  enabled: true,
  isCustom: false,
  providerType: "openai",
  requiresApiKey: true,
  sortOrder: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
} as DbProvider);

/** A `provider_models` row as Rust serialises it. */
const model = (providerId: string, modelKey: string, over: Partial<DbModel> = {}): DbModel =>
  ({
    id: `${providerId}::${modelKey}`,
    providerId,
    modelKey,
    label: null,
    contextWindow: null,
    maxOutputTokens: null,
    supportsVision: false,
    supportsThinking: false,
    supportsToolStream: false,
    enabled: true,
    sortOrder: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  }) as DbModel;

const PROVIDERS: DbProvider[] = [
  provider({
    id: "oa",
    name: "OpenAI",
    model: "gpt-4o",
    customHeaders: { "X-Org": "acme" },
    customParams: { bar: 2 },
    defaultTemperature: 0.7,
    defaultMaxTokens: 4096,
    toolImagesInResult: true,
  } as Partial<DbProvider> & Pick<DbProvider, "id" | "name">),
  provider({ id: "anth", name: "Anthropic", providerType: "anthropic", model: "claude", supportsToolStream: true }),
  provider({ id: "pool", name: "Pool", model: "m", apiKeys: ["k1", "  ", "k2"] } as Partial<DbProvider> & Pick<DbProvider, "id" | "name">),
  provider({
    id: "zero",
    name: "Zero",
    model: "z",
    providerType: "",
    contextWindow: 0,
    maxOutputTokens: 0,
    defaultTemperature: 0,
    defaultMaxTokens: 0,
    customParams: {},
  } as unknown as Partial<DbProvider> & Pick<DbProvider, "id" | "name">),
  provider({ id: "opencode-go", name: "OpenCode Go", providerType: "opencode-go-chat", model: "kimi-k3" }),
  provider({
    id: "antigravity",
    name: "Antigravity",
    providerType: "antigravity",
    model: "gemini-4-argon",
    customParams: { reasoning_effort: "medium", keep: 1 },
  } as Partial<DbProvider> & Pick<DbProvider, "id" | "name">),
  provider({
    id: "cursor",
    name: "Cursor",
    providerType: "cursor",
    model: "cursor-grok-4.6",
    customParams: { reasoning_effort: "high" },
  } as Partial<DbProvider> & Pick<DbProvider, "id" | "name">),
  provider({ id: "off", name: "Off", enabled: false, model: "x" }),
];

const MODELS: DbModel[] = [
  model("oa", "gpt-4o", { contextWindow: 200000, maxOutputTokens: 32000, supportsVision: true, temperature: 0.2 }),
  model("oa", "o4-mini", {
    supportsThinking: true,
    reasoning: { type: "effort", levels: ["low", "medium", "high"], default: "medium" },
    extraBody: { foo: 1, reasoning_replay: "off" },
  }),
  model("oa", "replay-only", { extraBody: { reasoning_replay: "reasoning" } }),
  model("anth", "claude", {
    supportsThinking: true,
    supportsToolStream: true,
    reasoning: { type: "budget", min: 1024, max: 32000, default: 8000 },
  }),
  model("anth", "claude-off", {
    supportsThinking: true,
    reasoning: { type: "effort", levels: ["low", "high"], default: "high", enabled: false },
  }),
  model("anth", "plain-thinker", { supportsThinking: true }),
  model("pool", "m", { sortOrder: 2 }),
  model("pool", "first", { sortOrder: 1 }),
  model("opencode-go", "kimi-k3"),
  model("opencode-go", "qwen3.9-max"),
  model("opencode-go", "grok-5"),
  model("opencode-go", "glm-5.3", { providerType: "opencode-go" }),
  model("antigravity", "gemini-4-argon", {
    supportsThinking: true,
    reasoning: { type: "effort", levels: ["low", "medium", "high"], default: "medium" },
  }),
  model("antigravity", "gemini-4-plain"),
  model("cursor", "cursor-grok-4.6", {
    reasoning: { type: "effort", levels: ["high", "xhigh"], default: "high" },
  }),
  model("cursor", "claude-opus-5", { supportsThinking: true, reasoning: { type: "toggle", default: true } }),
  model("cursor", "composer-2", { reasoning: { type: "effort", levels: ["max"], default: "max" } }),
];

const CURSOR_CATALOGUE = [
  "cursor-grok-4.6",
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-high-fast",
  "claude-opus-5-thinking",
  "claude-opus-5-thinking-high",
  "composer-2",
  "composer-2-fast",
];

/** Model row id → Fast on (the window's browser storage). */
const CURSOR_FAST: Record<string, boolean> = { "cursor::cursor-grok-4.6": true };

interface ProviderCase {
  name: string;
  selection: string;
  thinkingPreference?: boolean;
  compactionModel?: string;
}

const CASES: ProviderCase[] = [
  { name: "openai-plain", selection: "oa:gpt-4o" },
  { name: "openai-effort-extra-body", selection: "oa:o4-mini" },
  { name: "openai-replay-only-extra", selection: "oa:replay-only" },
  { name: "openai-thinking-off", selection: "oa:o4-mini", thinkingPreference: false },
  { name: "anthropic-budget", selection: "anth:claude" },
  { name: "anthropic-effort-disabled", selection: "anth:claude-off" },
  { name: "anthropic-thinker-no-profile", selection: "anth:plain-thinker" },
  { name: "no-model-row", selection: "oa:ghost-model" },
  { name: "empty-model-key", selection: "oa:" },
  { name: "provider-missing-falls-back", selection: "ghost:x" },
  { name: "pool-direct-drops-keys", selection: "pool:m" },
  { name: "zero-defaults", selection: "zero:z" },
  { name: "opencode-table", selection: "opencode-go:kimi-k3" },
  { name: "opencode-prefix", selection: "opencode-go:qwen3.9-max" },
  { name: "opencode-responses", selection: "opencode-go:grok-5" },
  { name: "opencode-override", selection: "opencode-go:glm-5.3" },
  { name: "antigravity-tier", selection: "antigravity:gemini-4-argon" },
  { name: "antigravity-plain", selection: "antigravity:gemini-4-plain" },
  { name: "cursor-effort-fast", selection: "cursor:cursor-grok-4.6" },
  { name: "cursor-thinking-only", selection: "cursor:claude-opus-5" },
  { name: "cursor-unsupported", selection: "cursor:composer-2" },
  { name: "cursor-unknown", selection: "cursor:nope" },
  { name: "compaction-pinned", selection: "oa:gpt-4o", compactionModel: "anth:claude" },
  { name: "compaction-pin-missing", selection: "oa:gpt-4o", compactionModel: "ghost:x" },
  // Found live: the pin's own Fast switch, on a chat model that is not Cursor.
  { name: "compaction-pin-cursor-fast", selection: "oa:gpt-4o", compactionModel: "cursor:cursor-grok-4.6" },
];

function seedStore(): void {
  useAgentSettingsStore.setState({
    providers: PROVIDERS.map(dbToProvider),
    models: MODELS.map(dbToModel),
    selectedModel: "pool:m",
  });
  primeCursorVariants(
    CURSOR_CATALOGUE.map<CursorModelView>((modelId, sortOrder) => ({
      modelId,
      displayModelId: null,
      displayName: null,
      displayNameShort: null,
      aliases: [],
      supportsThinking: modelId.includes("thinking"),
      maxMode: false,
      enabled: true,
      sortOrder,
      baseModelId: modelId.replace(/-fast$/, ""),
      isFast: modelId.endsWith("-fast"),
      catalogKey: null,
      isLegacy: false,
    })),
  );
  localStorage.setItem(CURSOR_FAST_KEY, JSON.stringify(CURSOR_FAST));
  resetFastPreferenceCache();
}

/** Exactly the request slice `useAgentWindowSend` sends for a selection. */
function sliceFor(c: ProviderCase): Record<string, unknown> {
  const thinkingPreference = c.thinkingPreference ?? true;
  let resolved: ReturnType<typeof resolveModelRequest>;
  try {
    resolved = resolveModelRequest(c.selection, thinkingPreference);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!resolved) return { error: "unresolved" };
  const { providerConfig, model: activeModel, reasoning, thinkingEnabled, thinkingBudgetTokens } = resolved;
  let compactionProvider;
  try {
    compactionProvider = c.compactionModel
      ? resolveModelRequest(c.compactionModel, thinkingPreference)?.providerConfig
      : undefined;
  } catch {
    compactionProvider = undefined;
  }
  const request = AgentRuntimeClient.buildRequest({
    turnId: "t",
    threadId: "th",
    input: { userMessage: "hi", tools: [], systemPrompt: "", ideContext: null } as AgentRuntimeChatInput,
    providerConfig,
    config: {
      executionMode: "agent",
      reasoning,
      thinkingEnabled,
      thinkingBudgetTokens,
      modelSelection: c.selection,
      temperature: resolveTemperature(activeModel, providerConfig.defaultTemperature),
      maxTokens:
        providerConfig.defaultMaxTokens ?? providerConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      compactionProvider,
    },
  });
  return {
    providerId: request.providerId,
    model: request.model,
    providerConfig: request.providerConfig,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    contextWindow: request.contextWindow,
    thinkingEnabled: request.thinkingEnabled,
    thinkingBudgetTokens: request.thinkingBudgetTokens,
    compactionProviderConfig: request.compactionProviderConfig,
  };
}

describe("provider snapshot golden files", () => {
  beforeAll(() => {
    seedStore();
    if (!UPDATE) return;
    mkdirSync(GOLDEN_DIR, { recursive: true });
    const inputs = {
      providers: PROVIDERS,
      models: MODELS,
      cursorCatalogue: CURSOR_CATALOGUE,
      cursorFast: CURSOR_FAST,
      selectedModel: "pool:m",
      cases: CASES.map((c) => ({
        name: c.name,
        selection: c.selection,
        thinkingPreference: c.thinkingPreference ?? true,
        compactionModel: c.compactionModel ?? "",
      })),
    };
    writeFileSync(`${GOLDEN_DIR}/cases.json`, `${JSON.stringify(inputs, null, 2)}\n`, "utf8");
  });

  it.each(CASES)("$name", (c) => {
    const json = `${JSON.stringify(sliceFor(c), null, 2)}\n`;
    const file = `${GOLDEN_DIR}/${c.name}.json`;
    if (UPDATE) {
      writeFileSync(file, json, "utf8");
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(json).toBe(readFileSync(file, "utf8"));
  });

  it("the window's own rules show in the slices", () => {
    // A direct selection never carries the key pool; only the fallback does.
    expect(
      (sliceFor({ name: "", selection: "pool:m" }).providerConfig as { apiKeys?: string[] }).apiKeys,
    ).toBeUndefined();
    expect(
      (sliceFor({ name: "", selection: "ghost:x" }).providerConfig as { apiKeys?: string[] }).apiKeys,
    ).toEqual(["k1", "k2"]);
    // Zeroed columns become the defaults, and a 0 temperature is "unset".
    const zero = sliceFor({ name: "", selection: "zero:z" });
    expect(zero.contextWindow).toBe(262000);
    expect(zero.maxOutputTokens).toBe(64000);
    expect(zero.temperature).toBeNull();
    // Cursor composes the id from the catalogue, the row's effort and Fast.
    expect(sliceFor({ name: "", selection: "cursor:cursor-grok-4.6" }).model).toBe("cursor-grok-4.6-high-fast");
    expect(String(sliceFor({ name: "", selection: "cursor:composer-2" }).error)).toContain("max effort");
  });
});
