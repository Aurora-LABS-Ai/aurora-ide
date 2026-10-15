/**
 * Agent Window — a react canvas drawn inline in a reply [view].
 *
 * `present_artifact` with `artifactPlacement: "inline"`. The same compiled,
 * sandboxed frame the dock shows, placed at the point in the reply where the
 * model called the tool and sized to its content (`CanvasReact fit="content"`).
 * A small interactive piece — a picker, tabs, a chart with a control — is used
 * where it is read instead of behind a tab in the side panel; the dock stays
 * for anything taller than a screen.
 *
 * The source comes from the conversation's own artifact store, by id and
 * version, without touching the dock's selection: reading a reply must not
 * change which canvas the panel is showing. "Open in dock" does that on
 * purpose, through the same path the launch card uses.
 */

import React, { useEffect, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { CanvasReact } from "@/apps/agent/components/canvas/CanvasReact";
import { listThreadArtifacts } from "@/apps/agent/services/artifacts/agent-artifacts";

type Load =
  | { state: "loading" }
  | { state: "ready"; source: string }
  | { state: "missing"; reason: string };

export const InlineCanvas: React.FC<{
  threadId: string;
  artifactId: string;
  versionTag: string;
  title: string;
  /** Opens the same canvas in the dock. */
  onOpenInDock: () => void;
}> = ({ threadId, artifactId, versionTag, title, onOpenInDock }) => {
  // Keyed on what was asked for, so a change of version shows "loading"
  // without an effect writing state synchronously (this codebase lints that
  // as an error): a result for another key is simply not this one's.
  const key = `${threadId}\n${artifactId}\n${versionTag}`;
  const [loaded, setLoaded] = useState<{ key: string; load: Load } | null>(null);
  const load: Load = loaded?.key === key ? loaded.load : { state: "loading" };

  useEffect(() => {
    let cancelled = false;
    const settle = (next: Load) => {
      if (!cancelled) setLoaded({ key, load: next });
    };
    void (async () => {
      try {
        const bundle = await listThreadArtifacts(threadId);
        const artifact = bundle.artifacts.find((a) => a.id === artifactId);
        const version = artifact?.versions.find((v) => v.tag === versionTag) ?? artifact?.versions.at(-1);
        if (!artifact || !version) {
          settle({ state: "missing", reason: "This canvas is no longer in the conversation." });
          return;
        }
        if (artifact.kind !== "react") {
          settle({ state: "missing", reason: "Only a react canvas can be shown inline." });
          return;
        }
        settle({ state: "ready", source: version.content });
      } catch (error: unknown) {
        settle({ state: "missing", reason: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, threadId, artifactId, versionTag]);

  return (
    <div className="agw-canvas-inline" data-state={load.state}>
      <div className="agw-canvas-inline-head">
        <span className="agw-canvas-inline-title">{title}</span>
        {versionTag && <span className="agw-canvas-inline-version">{versionTag}</span>}
        <button type="button" className="agw-canvas-inline-open" onClick={onOpenInDock}>
          <span>Open in dock</span>
          <AgentIcon name="panel-right" size={13} />
        </button>
      </div>
      {load.state === "ready" && (
        <CanvasReact source={load.source} title={title} refreshKey={0} fit="content" />
      )}
      {load.state === "missing" && <div className="agw-canvas-inline-missing">{load.reason}</div>}
    </div>
  );
};
