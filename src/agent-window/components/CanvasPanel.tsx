import React, { useEffect, useMemo, useState } from "react";

import type { AgentArtifactKind } from "../../services/agent-artifacts";
import { buildArtifactDocument } from "../lib/artifact-render";
import { useAgentArtifactStore } from "../store/useAgentArtifactStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { AgentIcon, AgentSelect } from "../shared";
import { AgentMarkdown } from "./AgentMarkdown";
import { CanvasDiagram } from "./CanvasDiagram";
import { ToolCode } from "./tool-views/ToolCode";

type CanvasMode = "preview" | "source";

const extensionFor = (kind: AgentArtifactKind): string => {
  if (kind === "markdown") return "md";
  if (kind === "mermaid") return "mmd";
  return kind;
};

export const CanvasPanel: React.FC = () => {
  const threadId = useAgentChatStore((state) => state.currentThreadId);
  const bundle = useAgentArtifactStore((state) =>
    threadId ? state.bundles[threadId] : undefined,
  );
  const loading = useAgentArtifactStore((state) =>
    threadId ? Boolean(state.loadingByThread[threadId]) : false,
  );
  const error = useAgentArtifactStore((state) =>
    threadId ? state.errorsByThread[threadId] : undefined,
  );
  const loadThread = useAgentArtifactStore((state) => state.loadThread);
  const select = useAgentArtifactStore((state) => state.select);
  const [mode, setMode] = useState<CanvasMode>("preview");
  const [refresh, setRefresh] = useState(0);
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    if (!threadId || bundle || loading) return;
    void loadThread(threadId).catch(() => undefined);
  }, [bundle, loadThread, loading, threadId]);

  const artifact = useMemo(() => {
    if (!bundle) return undefined;
    return (
      bundle.artifacts.find((entry) => entry.id === bundle.selectedArtifactId) ??
      bundle.artifacts[0]
    );
  }, [bundle]);
  const version = useMemo(() => {
    if (!artifact) return undefined;
    return (
      artifact.versions.find((entry) => entry.tag === bundle?.selectedVersionTag) ??
      artifact.versions[artifact.versions.length - 1]
    );
  }, [artifact, bundle?.selectedVersionTag]);
  const document = useMemo(() => {
    if (!artifact || !version || (artifact.kind !== "html" && artifact.kind !== "svg")) return null;
    return buildArtifactDocument(artifact.kind, version.content);
  }, [artifact, version]);

  const choose = async (artifactId: string, versionTag: string) => {
    if (!threadId) return;
    setSelecting(true);
    try {
      await select(threadId, artifactId, versionTag);
    } catch {
      return;
    } finally {
      setSelecting(false);
    }
  };

  if (!threadId) {
    return (
      <div className="agw-canvas-empty">
        <AgentIcon name="panel-right" size={24} />
        <strong>Canvas belongs to a conversation</strong>
        <span>Open a saved conversation to view its artifacts.</span>
      </div>
    );
  }

  if (loading && !bundle) {
    return (
      <div className="agw-canvas-empty" aria-live="polite">
        <AgentIcon name="retry" size={22} className="agw-canvas-spin" />
        <strong>Loading Canvas…</strong>
      </div>
    );
  }

  if (error && !bundle) {
    return (
      <div className="agw-canvas-empty" role="alert">
        <AgentIcon name="help" size={24} />
        <strong>Canvas couldn’t load</strong>
        <span>{error}</span>
        <button type="button" className="agw-canvas-retry" onClick={() => void loadThread(threadId)}>
          Try again
        </button>
      </div>
    );
  }

  if (!artifact || !version) {
    return (
      <div className="agw-canvas-empty">
        <AgentIcon name="panel-right" size={24} />
        <strong>Nothing on Canvas yet</strong>
        <span>When the agent creates a visual artifact, it will open here automatically.</span>
      </div>
    );
  }

  return (
    <section className="agw-canvas" aria-label="Artifact Canvas">
      <div className="agw-canvas-toolbar">
        <div className="agw-canvas-field">
          <span>Artifact</span>
          <AgentSelect
            value={artifact.id}
            disabled={selecting}
            ariaLabel="Artifact"
            minMenuWidth={180}
            options={(bundle?.artifacts ?? []).map((entry) => ({
              value: entry.id,
              label: entry.title,
            }))}
            onChange={(artifactId) => {
              const next = bundle?.artifacts.find((entry) => entry.id === artifactId);
              const latest = next?.versions[next.versions.length - 1];
              if (next && latest) void choose(next.id, latest.tag);
            }}
          />
        </div>

        <div className="agw-canvas-field agw-canvas-version">
          <span>Version</span>
          <AgentSelect
            value={version.tag}
            disabled={selecting}
            ariaLabel="Version"
            minMenuWidth={92}
            options={[...artifact.versions].reverse().map((entry) => ({
              value: entry.tag,
              label: entry.tag,
            }))}
            onChange={(versionTag) => void choose(artifact.id, versionTag)}
          />
        </div>

        <div className="agw-canvas-mode" role="group" aria-label="Canvas view">
          <button
            type="button"
            data-active={mode === "preview" || undefined}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            data-active={mode === "source" || undefined}
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
          >
            Source
          </button>
        </div>

        {mode === "preview" && artifact.kind !== "markdown" && (
          <button
            type="button"
            className="agw-canvas-refresh"
            aria-label="Reload preview"
            title="Reload preview"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <AgentIcon name="retry" size={14} />
          </button>
        )}
      </div>

      {error && bundle && (
        <div className="agw-canvas-error" role="alert">
          {error}
        </div>
      )}

      <div className="agw-canvas-meta">
        <span>{artifact.title}</span>
        <span>{artifact.kind.toUpperCase()}</span>
        <span>{version.tag}</span>
        <span>Saved</span>
      </div>

      <div className="agw-canvas-body">
        {mode === "source" ? (
          <ToolCode
            code={version.content}
            path={`${artifact.id}.${extensionFor(artifact.kind)}`}
          />
        ) : artifact.kind === "markdown" ? (
          <div className="agw-canvas-markdown agw-scroll">
            <AgentMarkdown content={version.content} />
          </div>
        ) : artifact.kind === "mermaid" ? (
          <CanvasDiagram
            key={`${artifact.id}:${version.tag}`}
            source={version.content}
            title={artifact.title}
            refreshKey={refresh}
          />
        ) : (
          <iframe
            key={`${artifact.id}:${version.tag}:${refresh}`}
            className="agw-canvas-frame"
            title={`${artifact.title} ${version.tag} preview`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={document ?? ""}
          />
        )}
      </div>
    </section>
  );
};
