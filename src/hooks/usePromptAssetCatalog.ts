import { useCallback, useEffect, useRef, useState } from "react";

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isAuroraRuntimeAvailable } from "../lib/runtime";
import {
  loadPromptAttachments,
  type PromptAttachment,
} from "../services/prompt-assets";

/**
 * Shared catalog state for the slash (`/`) prompt picker — currently rules and
 * skills loaded from the workspace and the global Aurora skills folder.
 *
 * Why this hook exists
 * --------------------
 * The chat input components used to call `loadPromptAttachments` once inside a
 * `useEffect` keyed on `[rootPath, skillToggles, skillsEnabled]`. That meant
 * adding a new file to `.aurora/`, `.aurora/skills/`, `.agents/skills/`, or the
 * global skills folder did not surface in the slash menu until the user closed
 * and reopened the IDE. This hook fixes that by:
 *
 * 1. Loading the catalog whenever any of the original deps change.
 * 2. Subscribing to the workspace `fs-changed` event and reloading whenever a
 *    path under the workspace prompt-asset folders is touched (debounced so a
 *    burst of edits coalesces into a single reload).
 * 3. Exposing `refreshCatalog()` so callers can guarantee a fresh catalog at
 *    the exact moment the slash menu opens — covering the global skills
 *    folder too, which lives outside the workspace watcher's tree.
 */

interface FsChangedPayload {
  paths: string[];
  kind: string;
}

const REACTIVE_REFRESH_DEBOUNCE_MS = 200;

/**
 * Returns true when `path` lives inside any of the workspace folders we use
 * for prompt assets. We only scope to the workspace watcher (rules + workspace
 * skills); the global skills folder is covered by `refreshCatalog` calls from
 * callers (e.g. when the slash menu opens).
 */
function isPromptAssetPath(rootPath: string, path: string): boolean {
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");

  if (!normalizedRoot || !normalizedPath.startsWith(normalizedRoot)) {
    return false;
  }

  const relative = normalizedPath.slice(normalizedRoot.length);
  // `.aurora/...` covers project rules (top-level *.md) and project skills.
  // `.agents/skills/...` covers the cross-agent shared skills convention.
  return (
    relative.startsWith("/.aurora/") ||
    relative === "/.aurora" ||
    relative.startsWith("/.agents/skills/") ||
    relative === "/.agents/skills"
  );
}

interface UsePromptAssetCatalogParams {
  rootPath: string | null;
  skillToggles: Record<string, boolean>;
  skillsEnabled: boolean;
}

interface UsePromptAssetCatalogResult {
  promptAssetCatalog: PromptAttachment[];
  refreshCatalog: () => void;
}

export function usePromptAssetCatalog(
  params: UsePromptAssetCatalogParams,
): UsePromptAssetCatalogResult {
  const { rootPath, skillToggles, skillsEnabled } = params;

  const [promptAssetCatalog, setPromptAssetCatalog] = useState<PromptAttachment[]>([]);

  // Bag of refs so `refreshCatalog` stays referentially stable while still
  // reading the latest props on every invocation.
  const rootPathRef = useRef(rootPath);
  const skillTogglesRef = useRef(skillToggles);
  const skillsEnabledRef = useRef(skillsEnabled);

  rootPathRef.current = rootPath;
  skillTogglesRef.current = skillToggles;
  skillsEnabledRef.current = skillsEnabled;

  // Each load is tagged with a monotonically increasing token so that a slow
  // load can't overwrite a newer one (e.g. user toggles a skill while a prior
  // load is still in flight).
  const loadTokenRef = useRef(0);

  const loadCatalog = useCallback(async () => {
    const myToken = ++loadTokenRef.current;
    try {
      const attachments = await loadPromptAttachments(rootPathRef.current, {
        enabledSkillToggles: skillTogglesRef.current,
        skillsEnabled: skillsEnabledRef.current,
      });
      // Discard the result if a newer load was kicked off while we were waiting.
      if (loadTokenRef.current === myToken) {
        setPromptAssetCatalog(attachments);
      }
    } catch (error) {
      console.warn("[usePromptAssetCatalog] Failed to load catalog:", error);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // 1) Reload whenever the original deps change (workspace switch, skill toggle).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    void loadCatalog();
    // We intentionally key only on the value-deps the catalog actually depends
    // on; `loadCatalog` is stable, so leaving it out keeps reloads predictable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, skillToggles, skillsEnabled]);

  // ---------------------------------------------------------------------------
  // 2) Reactive refresh on filesystem activity inside prompt-asset folders.
  //    The Rust workspace watcher (see `start_workspace_watcher`) emits
  //    `fs-changed` for every create / modify / remove inside the workspace.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isAuroraRuntimeAvailable() || !rootPath) {
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleReload = () => {
      if (debounceHandle) {
        clearTimeout(debounceHandle);
      }
      debounceHandle = setTimeout(() => {
        debounceHandle = null;
        void loadCatalog();
      }, REACTIVE_REFRESH_DEBOUNCE_MS);
    };

    const startListening = async () => {
      try {
        const unsubscribe = await listen<FsChangedPayload>(
          "fs-changed",
          (event) => {
            const payload = event.payload;
            if (!payload || cancelled) return;

            const kind = payload.kind ?? "any";
            // Access events are noise — don't reload for them.
            if (kind === "access") return;

            const currentRoot = rootPathRef.current;
            if (!currentRoot) return;

            const touched = (payload.paths ?? []).some((path) =>
              isPromptAssetPath(currentRoot, path),
            );
            if (touched) {
              scheduleReload();
            }
          },
        );

        if (cancelled) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
      } catch (error) {
        console.warn(
          "[usePromptAssetCatalog] Failed to subscribe to fs-changed:",
          error,
        );
      }
    };

    void startListening();

    return () => {
      cancelled = true;
      if (debounceHandle) {
        clearTimeout(debounceHandle);
        debounceHandle = null;
      }
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, [rootPath, loadCatalog]);

  // ---------------------------------------------------------------------------
  // 3) Imperative refresh — used by the slash menu open path so the picker is
  //    always up-to-date even when the change happened in the global skills
  //    folder (which lives outside the workspace watcher).
  // ---------------------------------------------------------------------------
  const refreshCatalog = useCallback(() => {
    void loadCatalog();
  }, [loadCatalog]);

  return { promptAssetCatalog, refreshCatalog };
}
