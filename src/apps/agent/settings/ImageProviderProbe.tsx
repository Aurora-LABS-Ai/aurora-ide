/**
 * Settings → Providers → Image providers → one card's **Test** and
 * **Discover models** [view].
 *
 * Both call the provider's `/models` with the saved address and key, through
 * the same Rust client `generate_image` uses — so a pass here is a pass on a
 * turn. Neither spends a generation.
 *
 * Inline rather than a hover panel: the LLM test lives in a dense scroll list
 * and needed a portal; this card is already expanded, and the verdict is
 * something to act on (add the models it found), not a readout to glance at.
 *
 * Its own file so `ImageProvidersSection` stays the form and this stays the
 * probe. The verdict is dropped whenever the address, key or format changes —
 * a green check against since-changed settings would be a lie.
 */

import React, { useState } from "react";

import { AgentIcon } from "@/apps/agent/shared";
import { AgwButton } from "@/apps/agent/settings/primitives";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import {
  discoverImageModels,
  testImageProvider,
  type DiscoveredImageModel,
  type ImageProviderTestReport,
} from "@/apps/agent/services/providers/image-provider-probe";
import type { ImageProvider } from "@/apps/agent/services/providers/image-providers";

type Probe =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "tested"; report: ImageProviderTestReport }
  | { kind: "discovering" }
  | { kind: "discovered"; models: DiscoveredImageModel[] }
  /** The IPC itself failed, or discovery was refused. */
  | { kind: "failed"; message: string };

/** "1.4s" reads better than "1423ms" at a glance. */
const formatLatency = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What decides the answer. Any change here invalidates the last verdict. */
const fingerprint = (provider: ImageProvider): string =>
  JSON.stringify([provider.baseUrl, provider.apiKey, provider.apiFormat]);

export const ImageProviderProbe: React.FC<{ provider: ImageProvider }> = ({ provider }) => {
  const addImageModel = useSettingsStore((s) => s.addImageModel);
  const [probe, setProbe] = useState<Probe>({ kind: "idle" });

  // Reset during render — the React-documented way to drop state a prop
  // change invalidated, with no extra render pass.
  const current = fingerprint(provider);
  const [probedFingerprint, setProbedFingerprint] = useState(current);
  if (current !== probedFingerprint) {
    setProbedFingerprint(current);
    setProbe({ kind: "idle" });
  }

  const busy = probe.kind === "testing" || probe.kind === "discovering";
  const configured = provider.baseUrl.trim() !== "" && (provider.apiKey ?? "").trim() !== "";

  const test = async () => {
    setProbe({ kind: "testing" });
    try {
      const report = await testImageProvider(provider);
      setProbe({ kind: "tested", report });
    } catch (error) {
      setProbe({ kind: "failed", message: message(error) });
    }
  };

  const discover = async () => {
    setProbe({ kind: "discovering" });
    try {
      const models = await discoverImageModels(provider);
      setProbe({ kind: "discovered", models });
    } catch (error) {
      setProbe({ kind: "failed", message: message(error) });
    }
  };

  const added = new Set(provider.models.map((model) => model.modelKey));

  return (
    <div className="agw-img-probe">
      <div className="agw-img-probe-actions">
        <AgwButton icon="plug" disabled={busy || !configured} onClick={() => void test()}>
          {probe.kind === "testing" ? "Testing…" : "Test connection"}
        </AgwButton>
        <AgwButton icon="search" disabled={busy || !configured} onClick={() => void discover()}>
          {probe.kind === "discovering" ? "Asking for the list…" : "Discover image models"}
        </AgwButton>
        {!configured && (
          <span className="agw-img-probe-note">Needs an address and a key first.</span>
        )}
      </div>

      {probe.kind === "tested" && (
        <div
          className="agw-img-probe-verdict"
          data-tone={probe.report.ok ? "good" : "bad"}
          role="status"
        >
          <AgentIcon name={probe.report.ok ? "check" : "alert"} size={13} />
          <span className="agw-img-probe-text">
            {probe.report.ok ? (
              <>
                Reached {provider.name} in {formatLatency(probe.report.latencyMs)}.{" "}
                {probe.report.imageModels === 0
                  ? "It lists no image models Aurora recognises — add yours by id below."
                  : `It lists ${probe.report.imageModels} image ${
                      probe.report.imageModels === 1 ? "model" : "models"
                    }.`}
              </>
            ) : (
              probe.report.error ?? "The provider did not answer."
            )}
            <span className="agw-img-probe-url">{probe.report.url}</span>
          </span>
        </div>
      )}

      {probe.kind === "failed" && (
        <div className="agw-img-probe-verdict" data-tone="bad" role="alert">
          <AgentIcon name="alert" size={13} />
          <span className="agw-img-probe-text">{probe.message}</span>
        </div>
      )}

      {probe.kind === "discovered" &&
        (probe.models.length === 0 ? (
          <div className="agw-img-probe-verdict" role="status">
            <AgentIcon name="help" size={13} />
            <span className="agw-img-probe-text">
              {provider.name} answered but listed no image models. If you know one, add it by
              id below.
            </span>
          </div>
        ) : (
          <ul className="agw-img-probe-list" aria-label="Discovered image models">
            {probe.models.map((model) => {
              const have = added.has(model.id);
              return (
                <li key={model.id}>
                  <span className="agw-prov-key">{model.id}</span>
                  {/* A guess is said to be one. The provider tagging it is a
                      fact; Aurora reading the name is not. */}
                  <span className="agw-img-probe-how">
                    {model.tagged ? "listed as an image model" : "name suggests an image model"}
                  </span>
                  {have ? (
                    <span className="agw-img-probe-have">Added</span>
                  ) : (
                    <button
                      type="button"
                      className="agw-img-probe-add"
                      onClick={() => addImageModel(provider.id, { modelKey: model.id })}
                    >
                      <AgentIcon name="plus" size={12} />
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
};
