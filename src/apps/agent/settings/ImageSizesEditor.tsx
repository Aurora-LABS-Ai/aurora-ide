/**
 * Settings → Image providers → a model's **Sizes** [view].
 *
 * Replaces two hand-typed fields (a comma-separated list and a separate
 * "Default size") with one control: the model's sizes as chips — click one to
 * make it the default, ✕ to remove it — then the common sizes it does not have
 * yet as one-click additions, then a field for anything else. Everything is
 * normalized on the way in (`lib/images/image-sizes`), because the Rust command
 * matches sizes as exact strings and `1024 X 1024` is not `1024x1024`.
 */

import React, { useState } from "react";

import { AgentIcon } from "@/apps/agent/shared";
import { AgwButton, AgwTextInput } from "@/apps/agent/settings/primitives";
import {
  addSize,
  normalizeSize,
  removeSize,
  setDefaultSize,
  sizeRatioLabel,
  SIZE_PRESETS,
  type SizeSet,
} from "@/apps/agent/lib/images/image-sizes";

export const ImageSizesEditor: React.FC<{
  sizes: string[];
  defaultSize?: string;
  onChange: (next: SizeSet) => void;
}> = ({ sizes, defaultSize, onChange }) => {
  const [draft, setDraft] = useState("");
  const set: SizeSet = { sizes, defaultSize };
  const presets = SIZE_PRESETS.filter((size) => !sizes.includes(size));
  const normalized = normalizeSize(draft);
  const duplicate = normalized !== null && sizes.includes(normalized);
  const invalid = draft.trim() !== "" && normalized === null;

  const addDraft = () => {
    if (!normalized || duplicate) return;
    onChange(addSize(set, normalized));
    setDraft("");
  };

  return (
    <div className="agw-img-sizes">
      {sizes.length > 0 ? (
        <div className="agw-img-sizes-list" role="radiogroup" aria-label="Default size">
          {sizes.map((size) => {
            const isDefault = size === defaultSize;
            const ratio = sizeRatioLabel(size);
            return (
              <span key={size} className="agw-img-size" data-default={isDefault || undefined}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isDefault}
                  className="agw-img-size-pick"
                  title={isDefault ? "The default size" : "Make this the default size"}
                  onClick={() => onChange(setDefaultSize(set, size))}
                >
                  <span className="agw-img-size-value">{size}</span>
                  {ratio && <span className="agw-img-size-ratio">{ratio}</span>}
                  {isDefault && <span className="agw-img-size-default">Default</span>}
                </button>
                <button
                  type="button"
                  className="agw-img-size-remove"
                  aria-label={`Remove ${size}`}
                  title="Remove this size"
                  onClick={() => onChange(removeSize(set, size))}
                >
                  <AgentIcon name="close" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="agw-img-sizes-empty">
          No sizes yet — the provider picks. Add the ones this model accepts; 1024x1024 is not
          universal.
        </p>
      )}

      {presets.length > 0 && (
        <div className="agw-img-sizes-presets" aria-label="Common sizes">
          <span className="agw-img-sizes-presets-label">Add</span>
          {presets.map((size) => (
            <button
              key={size}
              type="button"
              className="agw-img-size-preset"
              title={`Add ${size}`}
              onClick={() => onChange(addSize(set, size))}
            >
              <AgentIcon name="plus" size={11} />
              {size}
              <span className="agw-img-size-ratio">{sizeRatioLabel(size)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="agw-img-sizes-custom">
        <AgwTextInput
          value={draft}
          placeholder="Custom, e.g. 1280x720"
          aria-label="Custom size"
          aria-invalid={invalid || duplicate || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
        />
        <AgwButton onClick={addDraft} disabled={!normalized || duplicate}>
          Add
        </AgwButton>
      </div>
      {(invalid || duplicate) && (
        <span className="agw-img-field-hint" data-tone="warn" role="status">
          {duplicate ? `${normalized} is already listed.` : "Write it as WIDTHxHEIGHT, e.g. 1280x720, or auto."}
        </span>
      )}
    </div>
  );
};
