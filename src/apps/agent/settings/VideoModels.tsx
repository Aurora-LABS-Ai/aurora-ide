import { useEffect, useId, useState } from "react";
import { AgwButton } from "@/apps/agent/settings/primitives";
import {
  loadVideoCatalog,
  videoModelsFor,
  type VideoCatalog,
} from "@/apps/agent/services/providers/video-catalog";

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; catalog: VideoCatalog }
  | { kind: "error"; message: string };

const durationLabel = (values: number[]) =>
  values.length > 2 &&
  values.every((value, i) => i === 0 || value === values[i - 1] + 1)
    ? `${values[0]}-${values[values.length - 1]}s`
    : `${values.join(" / ")}s`;

/**
 * The built-in video models a provider row can drive.
 *
 * Read-only: video generation is a tool inside a chat turn, not a selectable
 * conversation model, so there is nothing to edit here. Discovery is local and
 * works without a key — it reports what is CONFIGURED, never a verified quota.
 */
export function VideoModels({ vendor }: { vendor: string }) {
  const headingId = useId();
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void loadVideoCatalog().then(
      (catalog) => {
        if (active) setState({ kind: "ready", catalog });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  const models = state.kind === "ready" ? videoModelsFor(state.catalog, vendor) : [];

  return (
    <section className="agw-prov-detail-models" aria-labelledby={headingId}>
      <div className="agw-prov-models-head" id={headingId}>
        Video models
        {state.kind === "ready" && (
          <span className="agw-prov-models-count">{models.length}</span>
        )}
      </div>
      <div className="agw-prov-models-panel">
        {state.kind === "loading" && (
          <div className="agw-prov-empty" role="status">
            Loading video models...
          </div>
        )}
        {state.kind === "error" && (
          <div className="agw-img-probe">
            <div className="agw-img-probe-verdict" data-tone="bad" role="alert">
              Could not load video models: {state.message}
            </div>
            <AgwButton
              onClick={() => {
                setState({ kind: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </AgwButton>
          </div>
        )}
        {state.kind === "ready" && models.length === 0 && (
          <div className="agw-prov-empty" role="status">
            This provider serves no video models.
          </div>
        )}
        {state.kind === "ready" && models.length > 0 && (
          <>
            <div className="agw-img-field-hint">
              Built-in models. Shared provider key. Quota not checked.
            </div>
            <div
              className="agw-prov-models agw-scroll"
              role="list"
              aria-label="Built-in video models"
            >
              {models.map((model) => (
                <div className="agw-prov-model" role="listitem" key={model.model}>
                  <div className="agw-prov-model-top">
                    <span className="agw-prov-model-main">
                      <span className="agw-prov-model-name">{model.label}</span>
                    </span>
                    {model.model === state.catalog.defaultModel && (
                      <span className="agw-prov-chip">Default</span>
                    )}
                  </div>
                  <div className="agw-prov-model-chips">
                    <span className="agw-prov-key">{model.model}</span>
                    <span className="agw-prov-meta-dot">{model.api}</span>
                  </div>
                  <div className="agw-prov-model-chips">
                    <span className="agw-img-field-hint">{model.input}</span>
                    <span className="agw-prov-meta-dot">
                      {durationLabel(model.duration)}
                    </span>
                    <span className="agw-prov-meta-dot">
                      {model.resolutions.join(" / ")}
                    </span>
                  </div>
                  <div className="agw-prov-model-chips">
                    <span className="agw-img-field-hint">{model.access}</span>
                    <span className="agw-prov-meta-dot">{model.note}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
