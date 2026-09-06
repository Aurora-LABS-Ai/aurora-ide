/**
 * Settings › Providers — the line under a provider's title.
 *
 * A provider's name says what it is called; this says what it is FOR — the
 * account, the plan, the team it belongs to, whatever you would otherwise
 * have to remember. It sits inline under the title, edits in place behind a
 * pencil, and is capped at `PROVIDER_DESCRIPTION_MAX` characters because it
 * is a line, not a note. Nothing written shows the pencil on its own — no
 * label, no empty box.
 *
 * Enter saves, Escape restores what was there, leaving the field saves too —
 * the same three rules every inline rename in the window follows.
 */

import React, { useEffect, useRef, useState } from "react";

import {
  PROVIDER_DESCRIPTION_MAX,
  normalizeProviderDescription,
} from "@/kernel/store/useSettingsStore";
import { AgentIcon } from "../shared/AgentIcon";

interface ProviderDescriptionProps {
  /** The provider's display name, for the accessible labels. */
  providerName: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}

export const ProviderDescription: React.FC<ProviderDescriptionProps> = ({
  providerName,
  value,
  onChange,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // The draft is seeded when editing BEGINS (see `begin`), so this effect only
  // has to place the caret: after mount, at the end, where a person continuing
  // a sentence expects it.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [editing]);

  const begin = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  const commit = () => {
    const next = normalizeProviderDescription(draft);
    if (next !== value) onChange(next);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value ?? "");
    setEditing(false);
  };

  if (editing) {
    const used = Array.from(draft).length;
    return (
      <div className="agw-prov-desc agw-prov-desc-editing">
        <input
          ref={inputRef}
          type="text"
          className="agw-prov-desc-input"
          value={draft}
          maxLength={PROVIDER_DESCRIPTION_MAX}
          placeholder="What this provider is for"
          aria-label={`Description for ${providerName}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
        <span
          className="agw-prov-desc-count"
          data-full={used >= PROVIDER_DESCRIPTION_MAX || undefined}
          aria-live="polite"
        >
          {used}/{PROVIDER_DESCRIPTION_MAX}
        </span>
      </div>
    );
  }

  // Nothing written: the pencil alone, in the place the description will
  // appear. A labelled button would be a sentence of chrome on every provider
  // card that has no description, which is most of them — the icon is the whole
  // affordance, and the tooltip carries the words for anyone who needs them.
  if (!value) {
    return (
      <div className="agw-prov-desc">
        <button
          type="button"
          className="agw-prov-desc-add"
          onClick={begin}
          aria-label={`Add a description for ${providerName}`}
          title="Add a description"
        >
          <AgentIcon name="pencil" size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="agw-prov-desc">
      <span className="agw-prov-desc-text" title={value}>
        {value}
      </span>
      <button
        type="button"
        className="agw-prov-desc-edit"
        onClick={begin}
        aria-label={`Edit description for ${providerName}`}
        title="Edit description"
      >
        <AgentIcon name="pencil" size={11} />
      </button>
    </div>
  );
};
