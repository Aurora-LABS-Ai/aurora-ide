import { describe, expect, it } from "vitest";

import type { LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { isBuiltInProvider } from "./built-in";
import {
  endpointIdentity,
  endpointLabel,
  endpointNameFromModelKey,
  endpointToModelInit,
  fmtUsd,
  isEndpointModelKey,
  isModalProvider,
  mergeEndpointModels,
  modalGatewayUrl,
  modalWire,
  modalWorkspaceOptions,
  profileForWorkspace,
  providerWorkspace,
  regionFromBaseUrl,
  workspaceFromModelKey,
  workspaceNickname,
  type ModalEndpointModel,
  type ModalProfile,
} from "./modal";

/** The live gateway answer for the maya workspace, 2026-09-02. */
const KIMI: ModalEndpointModel = {
  id: "maya--ep-kimi-k3-server.us-west.modal.direct",
  endpointName: "kimi-k3",
  workspace: "maya",
  region: "us-west",
  baseModelId: "moonshotai/Kimi-K3",
  displayName: "MoonshotAI: Kimi K3",
  contextLength: 1_048_576,
  maxOutputLength: 1_048_576,
  supportsVision: true,
  supportsTools: true,
  supportsReasoning: true,
  reasoningLevels: ["low", "high", "max"],
};

describe("modal hostnames", () => {
  it("reads the endpoint name and workspace out of the model id", () => {
    expect(endpointNameFromModelKey(KIMI.id)).toBe("kimi-k3");
    expect(workspaceFromModelKey(KIMI.id)).toBe("maya");
    expect(endpointNameFromModelKey("canyaman6879--ep-glm-5-3-server.eu-west.modal.direct")).toBe(
      "glm-5-3",
    );
  });

  it("leaves a plain model id alone rather than inventing a name", () => {
    expect(endpointNameFromModelKey("moonshotai/Kimi-K3")).toBe("moonshotai/Kimi-K3");
    expect(workspaceFromModelKey("moonshotai/Kimi-K3")).toBeNull();
  });

  it("maps a region to its gateway and back", () => {
    expect(modalGatewayUrl("eu-west")).toBe("https://inference.eu-west.modal.direct/v1");
    expect(regionFromBaseUrl("https://inference.eu-west.modal.direct/v1")).toBe("eu-west");
    expect(regionFromBaseUrl("https://inference.US-West.modal.direct/v1/")).toBe("us-west");
    expect(regionFromBaseUrl("https://maya--ep-kimi-k3-server.us-west.modal.direct/v1")).toBeNull();
  });
});

describe("modal provider rows", () => {
  it("is Modal on every wire, shipped or added by hand", () => {
    for (const providerType of ["modal", "modal-messages", "modal-responses"] as const) {
      const shipped = { id: "modal", providerType, isCustom: false };
      expect(isModalProvider(shipped)).toBe(true);
      expect(isBuiltInProvider(shipped)).toBe(true);
      expect(modalWire(shipped)).toBe(providerType);
      // A second workspace is a custom row with the same type family.
      expect(isModalProvider({ id: "uuid-1", providerType })).toBe(true);
    }
    expect(isModalProvider({ id: "kenari", providerType: "kenari" })).toBe(false);
  });

  it("falls back to the chat wire when none was chosen", () => {
    expect(modalWire({ id: "modal", providerType: undefined })).toBe("modal");
    expect(modalWire({ id: "modal", providerType: "openai" })).toBe("modal");
  });
});

describe("endpoint labels", () => {
  it("drops the vendor prefix and the auto-derived endpoint name", () => {
    // Modal names an endpoint after its model unless told otherwise, so
    // repeating that name is noise: "Z.AI: GLM 5.3 · glm-5-3" is the model
    // said three times.
    expect(endpointLabel(KIMI)).toBe("Kimi K3");
    expect(
      endpointLabel({ displayName: "Z.AI: GLM 5.3", baseModelId: "zai-org/GLM-5.3", endpointName: "glm-5-3" }),
    ).toBe("GLM 5.3");
  });

  it("keeps a custom endpoint name, because the person chose it", () => {
    expect(
      endpointLabel({ displayName: "Qwen: Qwen3.6 27B", baseModelId: "Qwen/Qwen3.6-27B", endpointName: "my-finetune" }),
    ).toBe("Qwen3.6 27B · my-finetune");
  });

  it("falls back to the repo name when the gateway sends no display name", () => {
    expect(
      endpointLabel({ displayName: "", baseModelId: "zai-org/GLM-5.3", endpointName: "glm-5-3" }),
    ).toBe("GLM-5.3");
  });
});

describe("endpoint → model row", () => {
  it("fills the row from what the gateway reports", () => {
    const init = endpointToModelInit(KIMI);
    expect(init.modelKey).toBe(KIMI.id);
    expect(init.label).toBe("Kimi K3");
    expect(init.contextWindow).toBe(1_048_576);
    expect(init.maxOutputTokens).toBeUndefined();
    expect(init.supportsVision).toBe(true);
    expect(init.supportsThinking).toBe(true);
    expect(init.reasoning).toEqual({
      type: "effort",
      levels: ["low", "high", "max"],
      default: "high",
      supported: ["effort"],
      toggleable: false,
    });
  });

  it("starts on the top effort when high is not offered", () => {
    const init = endpointToModelInit({ ...KIMI, reasoningLevels: ["medium", "max"] });
    expect(init.reasoning?.default).toBe("max");
    expect(endpointToModelInit({ ...KIMI, reasoningLevels: [] }).reasoning).toBeUndefined();
  });

  it("keeps what the person set and drops endpoints that are gone", () => {
    const existing: LLMModel[] = [
      {
        id: `modal::${KIMI.id}`,
        providerId: "modal",
        modelKey: KIMI.id,
        label: "old label",
        contextWindow: 1,
        supportsVision: false,
        supportsThinking: true,
        supportsToolStream: true,
        enabled: false,
        sortOrder: 0,
        priceCacheMissPerMtok: 3,
        priceOutputPerMtok: 15,
        temperature: 0.2,
        reasoning: { type: "effort", levels: ["low"], default: "max", replay: "off" },
      },
      {
        id: "modal::maya--ep-gone-server.us-west.modal.direct",
        providerId: "modal",
        modelKey: "maya--ep-gone-server.us-west.modal.direct",
        supportsVision: false,
        supportsThinking: false,
        supportsToolStream: false,
        enabled: true,
        sortOrder: 1,
      },
    ];
    const { models: merged, renames } = mergeEndpointModels(existing, [KIMI]);
    expect(merged).toHaveLength(1);
    expect(renames).toEqual({});
    const [row] = merged;
    // Gateway facts refreshed.
    expect(row.label).toBe("Kimi K3");
    expect(row.contextWindow).toBe(1_048_576);
    expect(row.supportsVision).toBe(true);
    expect(row.reasoning?.levels).toEqual(["low", "high", "max"]);
    // The person's choices kept.
    expect(row.enabled).toBe(false);
    expect(row.priceOutputPerMtok).toBe(15);
    expect(row.temperature).toBe(0.2);
    expect(row.reasoning?.default).toBe("max");
    expect(row.reasoning?.replay).toBe("off");
  });
});

describe("an endpoint that changed gateway", () => {
  /** The same deployment, listed by the eu-west gateway. */
  const KIMI_EU: ModalEndpointModel = {
    ...KIMI,
    id: "maya--ep-kimi-k3-server.eu-west.modal.direct",
    region: "eu-west",
  };

  it("knows an endpoint by workspace and name, not by hostname", () => {
    expect(endpointIdentity(KIMI.id)).toBe("maya/kimi-k3");
    expect(endpointIdentity(KIMI_EU.id)).toBe(endpointIdentity(KIMI.id));
    // A key that is not a Modal hostname is its own identity, so no rewrite
    // rule can fire on another provider's model.
    expect(endpointIdentity("claude-opus-5")).toBe("claude-opus-5");
    expect(isEndpointModelKey(KIMI.id)).toBe(true);
    expect(isEndpointModelKey("some--other-model")).toBe(false);
    expect(isEndpointModelKey("plain-model")).toBe(false);
  });

  it("carries the person's settings across a region change and reports the rename", () => {
    // Before this, a region change matched nothing: every row looked new, so
    // the price and effort set on each one were silently thrown away.
    const existing: LLMModel[] = [
      {
        id: `modal::${KIMI.id}`,
        providerId: "modal",
        modelKey: KIMI.id,
        supportsVision: true,
        supportsThinking: true,
        supportsToolStream: true,
        enabled: true,
        sortOrder: 0,
        priceOutputPerMtok: 15,
        temperature: 0.2,
        reasoning: { type: "effort", levels: ["low", "high", "max"], default: "max" },
      },
    ];
    const { models: merged, renames } = mergeEndpointModels(existing, [KIMI_EU]);
    expect(merged[0].modelKey).toBe(KIMI_EU.id);
    expect(merged[0].priceOutputPerMtok).toBe(15);
    expect(merged[0].temperature).toBe(0.2);
    expect(merged[0].reasoning?.default).toBe("max");
    expect(renames).toEqual({ [KIMI.id]: KIMI_EU.id });
  });
});

describe("workspaces", () => {
  const profiles: ModalProfile[] = [
    { name: "canyaman6879", workspace: "canyaman6879", active: false },
    { name: "work", workspace: "maya", active: true },
  ];

  it("reads the row's workspace from its endpoints, then from the name it wrote", () => {
    const model = { modelKey: KIMI.id } as LLMModel;
    expect(providerWorkspace({ nickname: undefined }, [model])).toBe("maya");
    // A token is saved but no endpoint has been pulled yet.
    expect(providerWorkspace({ nickname: workspaceNickname("maya") }, [])).toBe("maya");
    // A name the person typed is not a workspace claim.
    expect(providerWorkspace({ nickname: "My cheap GPUs" }, [])).toBeNull();
    expect(providerWorkspace({ nickname: undefined }, [])).toBeNull();
  });

  it("never offers a workspace Aurora already holds as one to set up", () => {
    // `maya` is saved, so the `work` profile that authenticates it must not
    // appear again — picking it would mint a second token for one workspace,
    // which is exactly what switching used to do every time.
    const options = modalWorkspaceOptions(
      [{ workspace: "maya", region: "us-west", endpointCount: 2 }],
      profiles,
    );
    expect(options).toEqual([
      { workspace: "canyaman6879", endpointCount: null, profileName: "canyaman6879" },
      { workspace: "maya", endpointCount: 2, profileName: null },
    ]);
  });

  it("offers a signed-in workspace Aurora has never held", () => {
    const options = modalWorkspaceOptions([], profiles);
    // `profileName` is set, which is what tells the card this one needs
    // minting; a saved workspace never carries it.
    expect(options.map((o) => [o.workspace, o.profileName])).toEqual([
      ["canyaman6879", "canyaman6879"],
      ["maya", "work"],
    ]);
  });

  it("lists what Aurora holds even with no CLI at all", () => {
    expect(modalWorkspaceOptions([{ workspace: "maya", region: "eu-west", endpointCount: 1 }], [])).toEqual([
      { workspace: "maya", endpointCount: 1, profileName: null },
    ]);
    expect(modalWorkspaceOptions([], [])).toEqual([]);
  });
});

describe("spend figures", () => {
  it("prints dollars the way Modal's own summary does", () => {
    expect(fmtUsd(0.16224736)).toBe("$0.16");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(12.4)).toBe("$12.40");
  });
});

describe("profile choice", () => {
  const profiles: ModalProfile[] = [
    { name: "canyaman6879", workspace: "canyaman6879", active: false },
    // A profile whose key is not its workspace, which `modal token new
    // --profile work` produces and `.modal.toml` cannot show.
    { name: "work", workspace: "maya", active: true },
  ];

  it("matches on the workspace a profile authenticates, not on its key", () => {
    expect(profileForWorkspace(profiles, "maya")?.name).toBe("work");
    // `work` is a profile KEY, not a workspace. Matching it would read one
    // workspace's spend under another's name and mint its token there.
    expect(profileForWorkspace(profiles, "work")).toBeNull();
  });

  it("has no profile for a workspace the CLI is not signed in to", () => {
    // The card offers no token button in this case rather than falling back to
    // the active profile, which would mint real credentials for the wrong
    // account and pull endpoints that are not this row's.
    expect(profileForWorkspace(profiles, "nobody")).toBeNull();
    expect(profileForWorkspace(profiles, null)).toBeNull();
    expect(profileForWorkspace([], "maya")).toBeNull();
  });
});
