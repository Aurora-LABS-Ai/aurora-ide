/**
 * Options for a "which model does this job" picker in settings.
 *
 * One leading row that stands for the default, then every configured model
 * keyed by `providerId:modelKey` — the selection format
 * `resolveModelRequest` reads. Compaction and reply suggestions both pick a
 * model this way, so they share one list instead of copies that drift apart.
 */

import { useMemo } from "react";

import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import type { SelectOption } from "./primitives";

/** The default row for a job that normally runs on the conversation's own model. */
export const SAME_AS_CHAT: SelectOption = {
  value: "",
  label: "Same as chat model",
  meta: "default",
};

export function useModelOptions(defaultOption: SelectOption): SelectOption[] {
  const providers = useAgentSettingsStore((s) => s.providers);
  const modelSlice = useAgentSettingsStore((s) => s.models);
  const getAvailableModels = useAgentSettingsStore((s) => s.getAvailableModels);
  const { value, label, meta } = defaultOption;

  return useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ value, label, meta }];
    for (const m of getAvailableModels()) {
      options.push({
        value: `${m.providerId}:${m.model}`,
        label: m.label,
        meta: m.providerName,
      });
    }
    return options;
    // `providers` and `models` are what `getAvailableModels` reads; listing
    // them is what makes the list follow a provider being added or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, modelSlice, getAvailableModels, value, label, meta]);
}
