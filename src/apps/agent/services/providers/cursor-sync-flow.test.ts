import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("@/apps/agent/services/providers/cursor", async () => {
  const actual = await vi.importActual<
    typeof import("@/apps/agent/services/providers/cursor")
  >("@/apps/agent/services/providers/cursor");
  return { ...actual, cursorModelsList: mocks.list };
});

vi.mock("@/apps/agent/services/providers/models-dev", async () => {
  const actual = await vi.importActual<
    typeof import("@/apps/agent/services/providers/models-dev")
  >("@/apps/agent/services/providers/models-dev");
  return { ...actual, lookupModel: mocks.lookup };
});

import { syncCursorModelsIntoStore } from "@/apps/agent/services/providers/cursor-sync";
import {
  clearCursorVariants,
  cursorHasFast,
  cursorVariantIndexSize,
} from "@/apps/agent/services/providers/cursor-variants";
import type { CursorModelView } from "@/apps/agent/services/providers/cursor";
import type { ModelsDevEntry } from "@/apps/agent/services/providers/models-dev";
import { useSettingsStore, type LLMModel } from "@/kernel/store/useSettingsStore";

const view = (
  modelId: string,
  enabled: boolean,
  sortOrder = 0,
): CursorModelView => ({
  modelId,
  displayModelId: null,
  displayName: "Grok 4.6",
  displayNameShort: null,
  aliases: [],
  supportsThinking: false,
  maxMode: false,
  enabled,
  sortOrder,
  baseModelId: modelId.replace(/-fast$/, ""),
  isFast: modelId.endsWith("-fast"),
  catalogKey: "grok-4.6",
  isLegacy: false,
});

const stored = (contextWindow: number): LLMModel =>
  ({
    id: "cursor::cursor-grok-4.6",
    providerId: "cursor",
    modelKey: "cursor-grok-4.6",
    contextWindow,
    enabled: true,
    sortOrder: 0,
  }) as LLMModel;

const catalog = {
  modelKey: "grok-4.6",
  providerId: "xai",
  name: "Grok 4.6",
  contextWindow: 500_000,
  maxOutputTokens: 64_000,
  supportsVision: true,
  supportsThinking: true,
} as ModelsDevEntry;

let originalModels: LLMModel[];
let originalReplace: ReturnType<typeof useSettingsStore.getState>["replaceModelsForProvider"];

beforeEach(() => {
  mocks.list.mockReset();
  mocks.lookup.mockReset();
  clearCursorVariants();
  const state = useSettingsStore.getState();
  originalModels = state.models;
  originalReplace = state.replaceModelsForProvider;
});

afterEach(() => {
  useSettingsStore.setState({
    models: originalModels,
    replaceModelsForProvider: originalReplace,
  });
});

describe("syncCursorModelsIntoStore", () => {
  it("primes variants before metadata awaits and preserves a concurrent edit", async () => {
    mocks.list.mockResolvedValue({
      models: [view("cursor-grok-4.6-high", true)],
      fetchedAt: null,
      enabledCount: 1,
    });
    let finishLookup!: (value: ModelsDevEntry | null) => void;
    mocks.lookup.mockImplementation(
      () => new Promise<ModelsDevEntry | null>((resolve) => {
        finishLookup = resolve;
      }),
    );
    const replace = vi.fn();
    useSettingsStore.setState({
      models: [stored(200_000)],
      replaceModelsForProvider: replace,
    });

    const syncing = syncCursorModelsIntoStore();
    await vi.waitFor(() => expect(cursorVariantIndexSize()).toBe(1));
    useSettingsStore.setState({ models: [stored(250_000)] });
    finishLookup(catalog);
    await syncing;

    const rows = replace.mock.calls[0][1] as Array<{ contextWindow?: number }>;
    expect(rows[0].contextWindow).toBe(250_000);
  });

  it("builds one enabled family from its complete variant matrix", async () => {
    mocks.list.mockResolvedValue({
      models: [
        view("cursor-grok-4.6-low", true, 0),
        view("cursor-grok-4.6-high", false, 1),
        view("cursor-grok-4.6-high-fast", false, 2),
      ],
      fetchedAt: null,
      enabledCount: 1,
    });
    mocks.lookup.mockResolvedValue(catalog);
    const replace = vi.fn();
    useSettingsStore.setState({
      models: [stored(200_000)],
      replaceModelsForProvider: replace,
    });

    await syncCursorModelsIntoStore();

    const rows = replace.mock.calls[0][1] as Array<{
      reasoning?: { levels?: string[] };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].reasoning?.levels).toEqual(["low", "high"]);
    expect(
      cursorHasFast("cursor-grok-4.6", { thinking: false, effort: "high" }),
    ).toBe(true);
  });
});
