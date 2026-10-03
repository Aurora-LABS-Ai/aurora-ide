/**
 * Settings → Providers → **Image providers** [view].
 *
 * Aurora Chat only. Build makes software and has no use for a picture
 * generator, and a section that appears on both sides would put a set of
 * fields on the coding side that mean nothing there.
 *
 * The shape follows the LLM provider cards on the same page — a row per
 * provider, models nested under it — because it is the same idea: one key and
 * one address serve several models, and what differs per model is what that
 * model can do.
 *
 * **Why every provider carries its own wire format.** a6api was probed live
 * and deviates from OpenAI's own image API in three measured ways — edits take
 * JSON with the image as a URL rather than multipart, errors arrive under HTTP
 * 200, and the per-model lookup contradicts the list. Any second provider will
 * deviate differently. A single hardcoded shape means the second provider added
 * breaks the first.
 */

import React, { useState } from "react";

import { AgentIcon } from "@/apps/agent/shared";
import { AgwButton, AgwSelect, AgwSwitch, AgwTextInput } from "@/apps/agent/settings/primitives";
import { ImageProviderProbe } from "@/apps/agent/settings/ImageProviderProbe";
import { ImageSizesEditor } from "@/apps/agent/settings/ImageSizesEditor";
import { VideoModels } from "@/apps/agent/settings/VideoModels";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  editUrl,
  generationUrl,
  IMAGE_API_FORMAT_LABELS,
  DEFAULT_IMAGE_PATHS,
  imageFormatUsesApiKey,
  imageProviderReady,
  type ImageApiFormat,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";

const FORMAT_OPTIONS = (Object.keys(IMAGE_API_FORMAT_LABELS) as ImageApiFormat[]).map(
  (id) => ({ value: id, label: IMAGE_API_FORMAT_LABELS[id] }),
);

/**
 * What Aurora puts in `response_format`. "Whatever it sends" omits the field —
 * the right answer for OpenAI's own `gpt-image-*`, which rejects it outright,
 * and the right default for a provider nobody has probed yet.
 */
const SHAPE_OPTIONS = [
  { value: "", label: "Whatever it sends" },
  { value: "url", label: "Ask for a URL" },
  { value: "b64_json", label: "Ask for base64" },
];

/** One field with its label above it. The card's only layout unit. */
const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <label className="agw-img-field">
    <span className="agw-img-field-label">{label}</span>
    {children}
    {hint && <span className="agw-img-field-hint">{hint}</span>}
  </label>
);

const ImageModelRow: React.FC<{ model: ImageModel; providerCanEdit: boolean; portraitReference?: boolean }> = ({
  model,
  providerCanEdit,
  portraitReference,
}) => {
  const updateImageModel = useAgentSettingsStore((s) => s.updateImageModel);
  const deleteImageModel = useAgentSettingsStore((s) => s.deleteImageModel);
  const [open, setOpen] = useState(false);

  return (
    <div className="agw-prov-model">
      <div className="agw-prov-model-top">
        <span className="agw-prov-model-main">
          <span className="agw-prov-model-name">{model.label || model.modelKey}</span>
        </span>
        <div className="agw-prov-model-actions">
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Model fields"
            aria-pressed={open}
            onClick={() => setOpen((v) => !v)}
            style={open ? { color: "var(--agw-accent)" } : undefined}
          >
            <AgentIcon name="sliders" size={14} />
          </button>
          <button
            type="button"
            className="agw-prov-icon-btn"
            title="Remove model"
            onClick={() => deleteImageModel(model.id)}
          >
            <AgentIcon name="close" size={14} />
          </button>
        </div>
      </div>

      <div className="agw-prov-model-chips">
        <span className="agw-prov-key">{model.modelKey}</span>
        {model.canEdit && <span className="agw-prov-chip">{portraitReference ? "Portrait reference" : "Can edit"}</span>}
        {model.defaultSize && <span className="agw-prov-meta-dot">{model.defaultSize}</span>}
        {/* Unset price says nothing rather than a measured $0.00. */}
        {typeof model.pricePerImage === "number" && (
          <span className="agw-prov-meta-dot">${model.pricePerImage} / image</span>
        )}
      </div>

      {open && (
        <div className="agw-img-fields">
          <Field label="Label">
            <AgwTextInput
              value={model.label ?? ""}
              placeholder={model.modelKey}
              onChange={(e) => updateImageModel(model.id, { label: e.target.value })}
            />
          </Field>
          {/* A div, not the `Field` label: the editor holds several buttons,
              and a <label> forwards a click anywhere inside it to its first
              control. Spans the grid — chips need the row's full width. */}
          <div className="agw-img-field agw-img-field-wide">
            <span className="agw-img-field-label">Sizes</span>
            <ImageSizesEditor
              sizes={model.sizes ?? []}
              defaultSize={model.defaultSize}
              onChange={(next) => updateImageModel(model.id, next)}
            />
          </div>
          <Field label="Price per image" hint="Leave blank if you do not know it.">
            <AgwTextInput
              value={model.pricePerImage === undefined ? "" : String(model.pricePerImage)}
              placeholder="—"
              inputMode="decimal"
              onChange={(e) => {
                const parsed = Number(e.target.value.trim());
                updateImageModel(model.id, {
                  pricePerImage:
                    e.target.value.trim() && Number.isFinite(parsed) ? parsed : undefined,
                });
              }}
            />
          </Field>
          <div className="agw-img-toggle-row">
            <span>
              {portraitReference ? "Can use a portrait reference" : "Can edit an existing image"}
              {!providerCanEdit && " — this provider has no edit endpoint"}
            </span>
            <AgwSwitch
              ariaLabel={portraitReference ? "This model can use a portrait reference" : "This model can edit an existing image"}
              checked={model.canEdit === true}
              disabled={!providerCanEdit}
              onChange={(next) => updateImageModel(model.id, { canEdit: next })}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export const ImageProviderCard: React.FC<{
  provider: ImageProvider;
  initiallyOpen: boolean;
  /**
   * This card IS the detail pane — the rail already chose this provider, so
   * there is nothing above it to collapse back into. Drops the fold entirely:
   * a header that shrinks the whole pane to a strip is a control with nowhere
   * to go.
   */
  standalone?: boolean;
}> = ({ provider, initiallyOpen, standalone = false }) => {
  const updateImageProvider = useAgentSettingsStore((s) => s.updateImageProvider);
  const deleteImageProvider = useAgentSettingsStore((s) => s.deleteImageProvider);
  const addImageModel = useAgentSettingsStore((s) => s.addImageModel);
  const [open, setOpen] = useState(initiallyOpen);
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const canEdit = editUrl(provider) !== null;
  const ready = imageProviderReady(provider);
  /**
   * Whether this row is something to configure at all. A Codex row has no
   * address, no key and no paths — showing them empty would read as six things
   * the user forgot to fill in, when the only setting that exists is the
   * sign-in on another page.
   */
  const configurable = imageFormatUsesApiKey(provider.apiFormat);

  const addModel = () => {
    const key = newModel.trim();
    if (!key) return;
    addImageModel(provider.id, { modelKey: key });
    setNewModel("");
  };

  const isOpen = standalone || open;
  const HeadTag = standalone ? "div" : "button";

  return (
    <div className="agw-img-card" data-open={isOpen || undefined} data-standalone={standalone || undefined}>
      <div className="agw-img-card-top">
        <HeadTag
          {...(standalone
            ? {}
            : {
                type: "button" as const,
                onClick: () => setOpen((v) => !v),
                "aria-expanded": open,
              })}
          className="agw-img-card-main"
        >
          <AgentIcon name="image" size={15} />
          <span className="agw-img-card-name">{provider.name}</span>
          <span className="agw-img-card-meta">
            {IMAGE_API_FORMAT_LABELS[provider.apiFormat]}
            {provider.models.length > 0 &&
              ` · ${provider.models.length} image model${provider.models.length === 1 ? "" : "s"}`}
          </span>
          {/* Not "not configured": say which piece is missing, or the user has
              to guess between an address, a key and the switch. */}
          {!ready && (
            <span className="agw-prov-chip" data-tone="override">
              {!provider.enabled
                ? "Off"
                : !provider.baseUrl.trim()
                  ? "No address"
                  : "No key"}
            </span>
          )}
          {!standalone && (
            <AgentIcon
              name="chevron-down"
              size={13}
              style={{
                marginLeft: "auto",
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform 0.18s ease",
              }}
            />
          )}
        </HeadTag>
        <AgwSwitch
          ariaLabel={`${provider.name} enabled`}
          checked={provider.enabled}
          onChange={(next) => updateImageProvider(provider.id, { enabled: next })}
        />
      </div>

      {isOpen && (
        <div className="agw-img-card-body">
          <div className="agw-img-fields">
            <Field label="Name">
              <AgwTextInput
                value={provider.name}
                onChange={(e) => updateImageProvider(provider.id, { name: e.target.value })}
              />
            </Field>
            {configurable ? (
              <>
                <Field label="Base URL">
                  <AgwTextInput
                    value={provider.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(e) => updateImageProvider(provider.id, { baseUrl: e.target.value })}
                  />
                </Field>
                <Field label={provider.apiFormat === "minimax-native" ? "Subscription Key or API key" : "API key"}>
                  <div className="agw-prov-key-row">
                    <AgwTextInput
                      type={showKey ? "text" : "password"}
                      value={provider.apiKey ?? ""}
                      placeholder="sk-…"
                      onChange={(e) => updateImageProvider(provider.id, { apiKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="agw-prov-icon-btn"
                      title={showKey ? "Hide key" : "Show key"}
                      onClick={() => setShowKey((v) => !v)}
                    >
                      <AgentIcon name="eye" size={14} />
                    </button>
                  </div>
                </Field>
                <Field
                  label="API format"
                  hint="What the requests look like on the wire. Measured per provider, never assumed."
                >
                  <AgwSelect
                    ariaLabel="API format"
                    value={provider.apiFormat}
                    options={FORMAT_OPTIONS}
                    onChange={(value) =>
                      updateImageProvider(provider.id, { apiFormat: value as ImageApiFormat })
                    }
                  />
                </Field>
                <Field label="Image generation path" hint={generationUrl(provider)}>
                  <AgwTextInput
                    value={provider.generationPath ?? ""}
                    placeholder={DEFAULT_IMAGE_PATHS[provider.apiFormat].generation}
                    onChange={(e) =>
                      updateImageProvider(provider.id, { generationPath: e.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Edit path"
                  hint={
                    canEdit
                      ? editUrl(provider) ?? ""
                      : "Empty — this provider cannot edit, only generate."
                  }
                >
                  <AgwTextInput
                    value={provider.editPath ?? ""}
                    placeholder={DEFAULT_IMAGE_PATHS[provider.apiFormat].edit}
                    onChange={(e) => updateImageProvider(provider.id, { editPath: e.target.value })}
                  />
                </Field>
                <Field
                  label="Image format"
                  hint="Leave as-is unless the provider's two endpoints disagree — some return a URL from one and base64 from the other."
                >
                  <AgwSelect
                    ariaLabel="Image format"
                    value={provider.requestFormat ?? ""}
                    options={SHAPE_OPTIONS}
                    onChange={(value) =>
                      updateImageProvider(provider.id, {
                        requestFormat:
                          value === "url" || value === "b64_json" ? value : undefined,
                      })
                    }
                  />
                </Field>
              </>
            ) : (
              <Field
                label="Account"
                hint="Pictures are made on your ChatGPT subscription and count against the same limits as Codex chat."
              >
                <p className="agw-img-note">
                  Signed in under Providers → Codex. Aurora uses whichever account is
                  serving there, and moves to the next one when a limit is reached.
                </p>
              </Field>
            )}
          </div>

          <ImageProviderProbe provider={provider} />

          {/* The models section a language provider already draws, reused whole:
              counted heading OUTSIDE the panel, list and add-row INSIDE it, so
              the panel is one object holding one list. The add row is the same
              markup as `AddModelRow` — plus glyph in the field, button at the
              right end of the SAME row, Enter adds. What was here before was a
              plain input with a labelled button stacked underneath: a second
              pattern for a job this page had already solved. */}
          <div className="agw-prov-detail-models">
            <div className="agw-prov-models-head">
              Image models <span className="agw-prov-models-count">{provider.models.length}</span>
            </div>
            <div className="agw-prov-models-panel">
              <div className="agw-prov-models agw-scroll">
                {provider.models.length === 0 ? (
                  <div className="agw-prov-empty">No models yet — add one below.</div>
                ) : (
                  provider.models.map((model) => (
                    <ImageModelRow key={model.id} model={model} providerCanEdit={canEdit} portraitReference={provider.apiFormat === "minimax-native"} />
                  ))
                )}
              </div>
              <div className="agw-prov-addwrap">
                <div className="agw-prov-addrow">
                  <div className="agw-prov-add-field">
                    <AgentIcon
                      name="plus"
                      size={14}
                      style={{ color: "var(--agw-text-subtle)" }}
                    />
                    <input
                      className="agw-prov-add-input"
                      aria-label="Add image model ID"
                      placeholder={provider.apiFormat === "minimax-native" ? "Image model ID - e.g. image-01" : "Image model ID - e.g. gpt-image-1.5, dall-e-3"}
                      value={newModel}
                      spellCheck={false}
                      onChange={(e) => setNewModel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addModel();
                      }}
                    />
                  </div>
                  <AgwButton
                    variant="primary"
                    icon="plus"
                    disabled={!newModel.trim()}
                    onClick={addModel}
                  >
                    Add
                  </AgwButton>
                </div>
              </div>
            </div>
          </div>

          {/* Both services serve video off the same key as their images, so
              the row that holds the key is where its video models belong. */}
          {provider.apiFormat === "minimax-native" && <VideoModels vendor="MiniMax" />}
          {provider.apiFormat === "qwen-dashscope" && <VideoModels vendor="Qwen" />}

          {/* Same two states a language provider shows, in the same place and
              the same words: a user-added row gets the two-click delete, a
              shipped one gets a line saying why there is nothing to click. A
              missing control with no explanation reads as a bug. */}
          {provider.builtIn ? (
            <div className="agw-prov-detail-note">
              Comes with Aurora. Change its address, key and image models freely — the provider
              itself stays in the list.
            </div>
          ) : (
            <div className="agw-prov-detail-danger">
              <button
                type="button"
                className="agw-prov-remove-btn"
                data-confirm={confirmRemove || undefined}
                onClick={() => {
                  if (!confirmRemove) {
                    setConfirmRemove(true);
                    return;
                  }
                  deleteImageProvider(provider.id);
                }}
                onMouseLeave={() => setConfirmRemove(false)}
              >
                <AgentIcon name="close" size={13} />
                {confirmRemove ? "Click again to delete" : "Delete provider"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

