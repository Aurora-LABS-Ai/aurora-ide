/**
 * Settings → Providers → **Add provider** [view].
 *
 * In Aurora Chat the page holds two kinds of provider — language models and
 * image providers — and one "Add" that silently picks a kind is how an image
 * service ends up with a context-window field. So the button first asks which
 * kind, in place: two choices where the button was, and Escape or a click
 * elsewhere puts the button back.
 *
 * In Build there is only one kind, so the button adds a language-model
 * provider directly and the question is never shown.
 */

import React, { useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared";
import { AgwButton } from "@/apps/agent/settings/primitives";

export type ProviderKind = "language-model" | "image";

interface AddProviderChooserProps {
  /** Whether the image kind exists here at all (Aurora Chat only). */
  offersImage: boolean;
  onAdd: (kind: ProviderKind) => void;
}

export const AddProviderChooser: React.FC<AddProviderChooserProps> = ({ offersImage, onAdd }) => {
  const [asking, setAsking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // A click anywhere else is "never mind". Listened for only while asking, so
  // the rest of the page pays nothing for a question it is not being asked.
  useEffect(() => {
    if (!asking) return;
    const away = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setAsking(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [asking]);

  if (!offersImage) {
    return (
      <AgwButton variant="primary" icon="plus" onClick={() => onAdd("language-model")}>
        Add provider
      </AgwButton>
    );
  }

  if (!asking) {
    return (
      <AgwButton variant="primary" icon="plus" onClick={() => setAsking(true)}>
        Add provider
      </AgwButton>
    );
  }

  const choose = (kind: ProviderKind) => {
    setAsking(false);
    onAdd(kind);
  };

  return (
    <div
      ref={rootRef}
      className="agw-prov-kind"
      role="group"
      aria-label="Which kind of provider"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <span className="agw-prov-kind-label">Add a</span>
      <button
        type="button"
        className="agw-prov-kind-btn"
        autoFocus
        onClick={() => choose("language-model")}
      >
        <AgentIcon name="providers" size={13} />
        Language model
      </button>
      <button type="button" className="agw-prov-kind-btn" onClick={() => choose("image")}>
        <AgentIcon name="image" size={13} />
        Image provider
      </button>
    </div>
  );
};
