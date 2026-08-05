import React, { useEffect, useMemo, useState } from "react";

import type { AgentArtifactKind } from "../../services/agent-artifacts";
import type { PlanStepStatus } from "../../services/agent-plans";
import { buildArtifactDocument } from "../lib/artifact-render";
import { useAgentArtifactStore } from "../store/useAgentArtifactStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import {
  presentPlanSteps,
  useAgentPlanStore,
  workspaceKey,
} from "../store/useAgentPlanStore";
import { AgentIcon, AgentSelect } from "../shared";
import { AgentMarkdown } from "./AgentMarkdown";
import { CanvasDiagram } from "./CanvasDiagram";
import { CanvasReact } from "./CanvasReact";
import { PlanCanvas } from "./PlanCanvas";
import { ToolCode } from "./tool-views/ToolCode";

type CanvasMode = "preview" | "source";

const extensionFor = (kind: AgentArtifactKind): string => {
  if (kind === "markdown") return "md";
  if (kind === "mermaid") return "mmd";
  if (kind === "react") return "tsx";
  return kind;
};

/**
 * What the kind is called to a person. `kind` is a storage enum, and shouting
 * `REACT` at the reader tells them about our implementation rather than about
 * their artifact — the name of the framework is not the name of the thing.
 */
const KIND_LABELS: Record<AgentArtifactKind, string> = {
  html: "Web page",
  svg: "Graphic",
  markdown: "Document",
  mermaid: "Diagram",
  react: "Interactive",
};

export const CanvasPanel: React.FC = () => {
  const threadId = useAgentChatStore((state) => state.currentThreadId);
  const projectRoot = useAgentChatStore((state) => state.projectRoot);
  const liveTurns = useAgentChatStore((state) => state.liveTurns);
  const plan = useAgentPlanStore((state) =>
    projectRoot ? state.byWorkspace[workspaceKey(projectRoot)] : undefined,
  );
  const planError = useAgentPlanStore((state) =>
    projectRoot ? state.errorsByWorkspace[workspaceKey(projectRoot)] : undefined,
  );
  const refreshPlan = useAgentPlanStore((state) => state.refresh);
  const setStepStatus = useAgentPlanStore((state) => state.setStepStatus);
  // Plan-vs-artifact lives in the ARTIFACT STORE, not component state: the
  // agent presents artifacts before this panel mounts, and a mount-time
  // default of "plan" was how every new diagram in a planned project ended up
  // invisible behind the plan.
  const source = useAgentArtifactStore((state) => state.canvasSource);
  const setSource = useAgentArtifactStore((state) => state.setCanvasSource);
  const [planBusy, setPlanBusy] = useState(false);
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

  // Disk is the source of truth, so re-read on every workspace change rather
  // than trusting a cached plan from the folder the user just left.
  useEffect(() => {
    if (!projectRoot) return;
    void refreshPlan(projectRoot);
  }, [projectRoot, refreshPlan]);

  /**
   * Liveness input: the threads streaming right now. A step whose run claim is
   * outside this set is paused, however recently it was marked in progress.
   */
  const liveThreadIds = useMemo(
    () => new Set(Object.keys(liveTurns ?? {})),
    [liveTurns],
  );
  const planStates = useMemo(
    () => (plan ? presentPlanSteps(plan, liveThreadIds) : new Map()),
    [plan, liveThreadIds],
  );

  const handleStepStatus = async (stepId: string, status: PlanStepStatus) => {
    if (!projectRoot || !plan) return;
    setPlanBusy(true);
    try {
      await setStepStatus(projectRoot, plan.id, stepId, status);
    } catch {
      // The store recorded the message; the panel keeps showing the last good
      // state rather than blanking out mid-run.
    } finally {
      setPlanBusy(false);
    }
  };

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

  const hasArtifact = Boolean(artifact && version);
  // A plan belongs to the workspace, so it shows whether or not a conversation
  // is open — and it outranks artifacts, because it is the active work.
  const showPlan = Boolean(plan) && (source === "plan" || !hasArtifact);

  const sourceSwitch = plan && hasArtifact && (
    <div className="agw-canvas-mode" role="group" aria-label="Canvas document">
      <button
        type="button"
        data-active={showPlan || undefined}
        aria-pressed={showPlan}
        onClick={() => setSource("plan")}
      >
        Plan
      </button>
      <button
        type="button"
        data-active={!showPlan || undefined}
        aria-pressed={!showPlan}
        onClick={() => setSource("artifact")}
      >
        Artifact
      </button>
    </div>
  );

  if (showPlan && plan) {
    return (
      <div className="agw-canvas-plan-wrap">
        {sourceSwitch && <div className="agw-canvas-toolbar">{sourceSwitch}</div>}
        {planError && (
          <div className="agw-canvas-error" role="alert">
            {planError}
          </div>
        )}
        <PlanCanvas
          plan={plan}
          states={planStates}
          onSetStepStatus={handleStepStatus}
          busy={planBusy}
        />
      </div>
    );
  }

  if (!threadId) {
    return (
      <div className="agw-canvas-empty">
        <AgentIcon name="panel-right" size={24} />
        <strong>Nothing on Canvas yet</strong>
        <span>
          Switch the composer to Plan mode and ask for a plan, and it will be
          written here as you agree it.
        </span>
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
        <span>
          Ask for a plan in Plan mode, or let the agent build a diagram or
          prototype — either one opens here automatically.
        </span>
      </div>
    );
  }

  return (
    <section className="agw-canvas" aria-label="Artifact Canvas">
      <div className="agw-canvas-toolbar">
        {sourceSwitch}
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

      {/* The artifact's own name is already in the selector directly above, so
          repeating it here says nothing. What this strip is for is the state
          the selector does not show: what kind of thing it is, and that it is
          on disk. */}
      <div className="agw-canvas-meta">
        <span>{KIND_LABELS[artifact.kind]}</span>
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
        ) : artifact.kind === "react" ? (
          <CanvasReact
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
