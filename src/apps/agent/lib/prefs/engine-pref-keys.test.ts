import { describe, expect, it } from "vitest";

import { ENGINE_PREF_KEYS } from "@/kernel/lib/prefs/engine-prefs";
import { CHOICE_KEY, SIZE_KEY } from "@/apps/agent/lib/images/image-model-choice";
import { CURSOR_FAST_KEY } from "@/apps/agent/lib/model/cursor-fast";
import { MODEL_USAGE_KEY } from "@/apps/agent/lib/model/model-usage";
import { PINNED_PROJECTS_KEY, SORT_KEY } from "@/apps/agent/lib/workspace/project-order";
import { PINNED_PROVIDERS_KEY } from "@/apps/agent/settings/provider-pins";
import { useAgentRefineStore } from "@/apps/agent/store/composer/useAgentRefineStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

// The kernel lists the engine's preference keys by their text, since it cannot
// import from the apps. A key renamed here and not there would quietly stop
// following the user to other clients.
describe("engine preference keys", () => {
  it("lists every key the agent window writes through the engine", () => {
    const owned = [
      useAgentThemeStore.persist.getOptions().name,
      useAgentRefineStore.persist.getOptions().name,
      PINNED_PROJECTS_KEY,
      SORT_KEY,
      MODEL_USAGE_KEY,
      CURSOR_FAST_KEY,
      CHOICE_KEY,
      SIZE_KEY,
      PINNED_PROVIDERS_KEY,
    ];
    expect([...owned].sort()).toEqual([...ENGINE_PREF_KEYS].sort());
  });
});
