import React, { useEffect, useMemo, useRef, useState } from "react";

import type { AgentArtifactKind } from "@/apps/agent/services/artifacts/agent-artifacts";
import type { PlanStepStatus } from "@/apps/agent/services/plans/agent-plans";
import { buildArtifactDocument } from "@/apps/agent/lib/render/artifact-render";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  presentPlanSteps,
  useAgentPlanStore,
  workspaceKey,
} from "@/apps/agent/store/artifacts/useAgentPlanStore";
import { AgentIcon, AgentSelect } from "@/apps/agent/shared";
import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { AgentMarkdown } from "@/apps/agent/components/conversation/AgentMarkdown";
import { CanvasDiagram } from "@/apps/agent/components/canvas/CanvasDiagram";
import { CanvasReact } from "@/apps/agent/components/canvas/CanvasReact";
import { CanvasReport } from "@/apps/agent/components/canvas/CanvasReport";
import { PlanCanvas } from "@/apps/agent/components/canvas/PlanCanvas";
import { ToolCode } from "@/apps/agent/components/tool-views/ToolCode";

type CanvasMode = "preview" | "source";

const extensionFor = (kind: AgentArtifactKind): string => {
  if (kind === "markdown" || kind === "report") return "md";
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
  report: "Report",
};

/** The index row's glyph. Same idea as `KIND_LABELS`: what it is, not what built it. */
const INDEX_ICONS: Record<AgentArtifactKind, AgentIconName> = {
  html: "browser",
  svg: "palette",
  markdown: "book",
  mermaid: "workspace-tree",
  react: "layers",
  report: "book-open",
};

interface CanvasPanelProps {
  /**
   * Show ONE artifact, in its own dock tab.
   *
   * Without it this is the Canvas tab: the index of everything the open
   * conversation has made. A conversation that produced six reports and
   * diagrams is browsed rather than paged through with a dropdown, and two of
   * them are often wanted side by side — which a single Canvas surface cannot
   * do however good its selector is.
   */
  artifactId?: string;
}

export const CanvasPanel: React.FC<CanvasPanelProps> = ({ artifactId }) => {
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
  // The rendered report body, for the PDF copy. See `CanvasReport.bodyRef`.
  const reportBodyRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState<null | "md" | "pdf">(null);
  const [saveNote, setSaveNote] = useState("");

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
    // An artifact tab is pinned to ITS artifact and never falls back to
    // another one: silently showing a different document under the same tab
    // title is worse than saying the one you opened is gone.
    if (artifactId) return bundle.artifacts.find((entry) => entry.id === artifactId);
    return (
      bundle.artifacts.find((entry) => entry.id === bundle.selectedArtifactId) ??
      bundle.artifacts[0]
    );
  }, [artifactId, bundle]);
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

  /**
   * Save the open report, as its own source or as a printed copy.
   *
   * Both go through the OS dialog, so the user picks the destination. The
   * model is not involved and never learns the path — chat mode's
   * no-filesystem rule is about the agent, not about the person using it.
   */
  const saveReport = async (format: "md" | "pdf") => {
    if (!artifact || !version) return;
    setSaving(format);
    setSaveNote("");
    try {
      const [{ parseReportDocument }, exporter] = await Promise.all([
        import("@/apps/agent/services/artifacts/report-document"),
        import("@/apps/agent/services/artifacts/report-export"),
      ]);
      let outcome: "saved" | "cancelled" | "failed";
      if (format === "md") {
        outcome = await exporter.saveReportMarkdown(artifact.title, version.content);
      } else {
        const { headings, sources } = parseReportDocument(version.content);
        outcome = await exporter.printReport({
          // The artifact's title, not the document's own `#` heading: the
          // filename should match what the user sees the report called.
          title: artifact.title,
          // What is on screen, so the page matches the panel rather than a
          // second rendering of the same source.
          bodyHtml: reportBodyRef.current?.innerHTML ?? "",
          headings,
          sources,
        });
      }
      if (outcome === "failed") {
        setSaveNote(
          format === "md" ? "Could not write the file." : "Could not open the print dialog.",
        );
      }
    } finally {
      setSaving(null);
    }
  };

  /** The index — everything this conversation made — is what Canvas itself is. */
  const isIndex = !artifactId;
  const madeAnything = (bundle?.artifacts.length ?? 0) > 0;
  // A plan belongs to the workspace, so it shows whether or not a conversation
  // is open — and it outranks artifacts, because it is the active work. An
  // artifact tab is never the plan: it was opened by name.
  const showPlan = isIndex && Boolean(plan) && (source === "plan" || !madeAnything);

  const sourceSwitch = isIndex && plan && madeAnything && (
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
        Artifacts
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

  // ── The index ──────────────────────────────────────────────────────────
  //
  // Reopening a conversation lands here, not inside whichever artifact was
  // last selected: the useful first question about a chat that produced six
  // things is "what did it make", and answering it with one of them and a
  // dropdown makes the other five easy to miss.
  if (isIndex && madeAnything) {
    return (
      <section className="agw-canvas" aria-label="Artifacts">
        {sourceSwitch && <div className="agw-canvas-toolbar">{sourceSwitch}</div>}
        {error && (
          <div className="agw-canvas-error" role="alert">
            {error}
          </div>
        )}
        <div className="agw-canvas-index agw-scroll">
          <span className="agw-canvas-index-label">
            {bundle!.artifacts.length === 1
              ? "1 artifact in this conversation"
              : `${bundle!.artifacts.length} artifacts in this conversation`}
          </span>
          <ul>
            {bundle!.artifacts.map((entry) => {
              const latest = entry.versions[entry.versions.length - 1];
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() =>
                      useAgentWorkspaceStore.getState().openArtifactTab(entry.id, entry.title)
                    }
                  >
                    <AgentIcon name={INDEX_ICONS[entry.kind]} size={15} />
                    <span className="agw-canvas-index-main">
                      <span className="agw-canvas-index-title">{entry.title}</span>
                      <span className="agw-canvas-index-meta">
                        {KIND_LABELS[entry.kind]}
                        {latest ? ` · ${latest.tag}` : ""}
                        {entry.versions.length > 1
                          ? ` · ${entry.versions.length} versions`
                          : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    );
  }

  if (!artifact || !version) {
    return (
      <div className="agw-canvas-empty">
        <AgentIcon name="panel-right" size={24} />
        <strong>{artifactId ? "That artifact is gone" : "Nothing on Canvas yet"}</strong>
        <span>
          {artifactId
            ? "It was deleted with its conversation, or this is a different chat. Close this tab and pick another from Canvas."
            : "Ask for a plan in Plan mode, or let the agent build a diagram or prototype — either one opens here automatically."}
        </span>
      </div>
    );
  }

  return (
    <section className="agw-canvas" aria-label="Artifact Canvas">
      <div className="agw-canvas-toolbar">
        {sourceSwitch}
        {/* No artifact picker: this tab IS one artifact, named in its own tab
            pill, and Canvas beside it is the list of the rest. */}
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

        {/* A report is a document, so it is the one kind you take away with
            you. Two formats because they are for two different afterwards:
            Markdown stays editable, PDF is the copy you send someone. */}
        {artifact.kind === "report" && mode === "preview" && (
          <div className="agw-canvas-export" role="group" aria-label="Save report">
            <span>Save as</span>
            <button type="button" disabled={saving !== null} onClick={() => void saveReport("md")}>
              {saving === "md" ? "Saving…" : "Markdown"}
            </button>
            <button type="button" disabled={saving !== null} onClick={() => void saveReport("pdf")}>
              {saving === "pdf" ? "Printing…" : "PDF"}
            </button>
          </div>
        )}

        {mode === "preview" && artifact.kind !== "markdown" && artifact.kind !== "report" && (
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

      {saveNote && (
        <div className="agw-canvas-error" role="alert">
          {saveNote}
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
        ) : artifact.kind === "report" ? (
          <CanvasReport
            key={`${artifact.id}:${version.tag}`}
            source={version.content}
            title={artifact.title}
            bodyRef={reportBodyRef}
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
