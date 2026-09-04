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
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import {
  editUrl,
  generationUrl,
  IMAGE_API_FORMAT_LABELS,
  imageProviderReady,
  type ImageApiFormat,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";

const FORMAT_OPTIONS = (Object.keys(IMAGE_API_FORMAT_LABELS) as ImageApiFormat[]).map(
  (id) => ({ value: id, label: IMAGE_API_FORMAT_LABELS[id] }),
);

const SHAPE_OPTIONS = [
  { value: "url", label: "url" },
  { value: "b64_json", label: "b64_json" },
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

const ImageModelRow: React.FC<{ model: ImageModel; providerCanEdit: boolean }> = ({
  model,
  providerCanEdit,
}) => {
  const updateImageModel = useSettingsStore((s) => s.updateImageModel);
  const deleteImageModel = useSettingsStore((s) => s.deleteImageModel);
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
        {model.canEdit && <span className="agw-prov-chip">Can edit</span>}
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
          <Field
            label="Sizes"
            hint="Comma separated, e.g. 1024x1024, 1536x1024. 1024x1024 is not universal."
          >
            <AgwTextInput
              value={(model.sizes ?? []).join(", ")}
              placeholder="1024x1024"
              onChange={(e) =>
                updateImageModel(model.id, {
                  sizes: e.target.value
                    .split(",")
                    .map((size) => size.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="Default size">
            <AgwTextInput
              value={model.defaultSize ?? ""}
              placeholder={model.sizes?.[0] ?? "1024x1024"}
              onChange={(e) => updateImageModel(model.id, { defaultSize: e.target.value })}
            />
          </Field>
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
              Can edit an existing image
              {!providerCanEdit && " — this provider has no edit endpoint"}
            </span>
            <AgwSwitch
              ariaLabel="This model can edit an existing image"
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

const ImageProviderCard: React.FC<{ provider: ImageProvider; initiallyOpen: boolean }> = ({
  provider,
  initiallyOpen,
}) => {
  const updateImageProvider = useSettingsStore((s) => s.updateImageProvider);
  const deleteImageProvider = useSettingsStore((s) => s.deleteImageProvider);
  const addImageModel = useSettingsStore((s) => s.addImageModel);
  const [open, setOpen] = useState(initiallyOpen);
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const canEdit = editUrl(provider) !== null;
  const ready = imageProviderReady(provider);

  const addModel = () => {
    const key = newModel.trim();
    if (!key) return;
    addImageModel(provider.id, { modelKey: key });
    setNewModel("");
  };

  return (
    <div className="agw-img-card" data-open={open || undefined}>
      <div className="agw-img-card-top">
        <button
          type="button"
          className="agw-img-card-main"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <AgentIcon name="image" size={15} />
          <span className="agw-img-card-name">{provider.name}</span>
          <span className="agw-img-card-meta">
            {IMAGE_API_FORMAT_LABELS[provider.apiFormat]}
            {provider.models.length > 0 &&
              ` · ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`}
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
          <AgentIcon
            name="chevron-down"
            size={13}
            style={{
              marginLeft: "auto",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.18s ease",
            }}
          />
        </button>
        <AgwSwitch
          ariaLabel={`${provider.name} enabled`}
          checked={provider.enabled}
          onChange={(next) => updateImageProvider(provider.id, { enabled: next })}
        />
      </div>

      {open && (
        <div className="agw-img-card-body">
          <div className="agw-img-fields">
            <Field label="Name">
              <AgwTextInput
                value={provider.name}
                onChange={(e) => updateImageProvider(provider.id, { name: e.target.value })}
              />
            </Field>
            <Field label="Base URL">
              <AgwTextInput
                value={provider.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => updateImageProvider(provider.id, { baseUrl: e.target.value })}
              />
            </Field>
            <Field label="API key">
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
            <Field label="Generation path" hint={generationUrl(provider)}>
              <AgwTextInput
                value={provider.generationPath ?? ""}
                placeholder="/images/generations"
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
                placeholder="/images/edits"
                onChange={(e) => updateImageProvider(provider.id, { editPath: e.target.value })}
              />
            </Field>
            <Field label="Response shape" hint="What each image comes back as.">
              <AgwSelect
                ariaLabel="Response shape"
                value={provider.responseShape}
                options={SHAPE_OPTIONS}
                onChange={(value) =>
                  updateImageProvider(provider.id, {
                    responseShape: value === "b64_json" ? "b64_json" : "url",
                  })
                }
              />
            </Field>
          </div>

          <ImageProviderProbe provider={provider} />

          <div className="agw-prov-models-head">
            <span>Models</span>
          </div>
          <div className="agw-prov-models">
            {provider.models.length === 0 ? (
              <div className="agw-prov-empty">No models yet — add one below.</div>
            ) : (
              provider.models.map((model) => (
                <ImageModelRow key={model.id} model={model} providerCanEdit={canEdit} />
              ))
            )}
          </div>

          <div className="agw-prov-addrow">
            <AgwTextInput
              value={newModel}
              placeholder="Model id — e.g. gpt-image-1.5"
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addModel();
              }}
            />
            <AgwButton icon="plus" disabled={!newModel.trim()} onClick={addModel}>
              Add model
            </AgwButton>
          </div>

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
        </div>
      )}
    </div>
  );
};

export const ImageProvidersSection: React.FC<{
  /**
   * A provider just added from the page's "Add provider" — the section opens
   * and that card opens with it, so the new row is the thing on screen rather
   * than one more collapsed line under a collapsed heading.
   */
  revealProviderId?: string | null;
}> = ({ revealProviderId = null }) => {
  const imageProviders = useSettingsStore((s) => s.imageProviders);
  const addImageProvider = useSettingsStore((s) => s.addImageProvider);
  const [open, setOpen] = useState(imageProviders.length > 0);
  // Adds from inside the section reveal their card the same way.
  const [addedHere, setAddedHere] = useState<string | null>(null);
  const reveal = addedHere ?? revealProviderId;

  // Open on a reveal, during render — the documented way to react to a prop
  // change without an effect and a second paint.
  const [seenReveal, setSeenReveal] = useState(revealProviderId);
  if (revealProviderId !== seenReveal) {
    setSeenReveal(revealProviderId);
    if (revealProviderId) setOpen(true);
  }

  const add = () => {
    setAddedHere(
      addImageProvider({
        name: "New image provider",
        baseUrl: "",
        apiFormat: "openai-images",
        responseShape: "url",
        enabled: true,
      }),
    );
  };

  return (
    <section className="agw-img-section">
      <button
        type="button"
        className="agw-img-section-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <AgentIcon
          name="chevron-down"
          size={13}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.18s ease" }}
        />
        <span>Image providers</span>
        <span className="agw-img-section-count">
          {imageProviders.length === 0 ? "none yet" : imageProviders.length}
        </span>
      </button>

      {open && (
        <div className="agw-img-section-body">
          {imageProviders.length === 0 && (
            <p className="agw-img-section-empty">
              Somewhere to generate pictures from a chat. Add the service you have a key
              for — its address and its wire format are per provider, because they genuinely
              differ.
            </p>
          )}
          {imageProviders.map((provider) => (
            <ImageProviderCard
              key={provider.id}
              provider={provider}
              initiallyOpen={provider.id === reveal}
            />
          ))}
          <AgwButton icon="plus" onClick={add}>
            Add image provider
          </AgwButton>
        </div>
      )}
    </section>
  );
};
