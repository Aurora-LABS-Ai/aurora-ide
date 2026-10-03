/**
 * Agent Window — one pickable row in the model list [view].
 *
 * A row is for PICKING and nothing else: name, the provider where no section
 * header states it, a glyph only where the model is the exception, and the
 * check on the one you are using. Reasoning and Fast moved to the selected-
 * model card at the top of the menu, so an option holds no controls — which
 * is what lets the list be a real listbox the arrow keys and a screen reader
 * can both walk.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";

import type { RichOption } from "./model-option";

export const ModelRow: React.FC<{
  opt: RichOption;
  /** DOM id, so the search box can point `aria-activedescendant` at it. */
  id: string;
  selected: boolean;
  /** The row the arrow keys (or the pointer) are on. */
  active: boolean;
  /** Only where no section header already names the provider. */
  showProvider: boolean;
  /** Cursor's faster lane is on for this model — an exception worth marking. */
  fastOn: boolean;
  onPoint: () => void;
  onPick: () => void;
}> = ({ opt, id, selected, active, showProvider, fastOn, onPoint, onPick }) => (
  <div
    id={id}
    role="option"
    aria-selected={selected}
    // Not a Tab stop: the search box owns focus and the arrow keys move
    // between rows. A Tab stop per row meant forty presses to cross the list.
    tabIndex={-1}
    className="agw-model-item"
    data-active={selected || undefined}
    data-kbd-active={active || undefined}
    onMouseEnter={onPoint}
    onClick={onPick}
  >
    <span className="agw-model-meta">
      <span className="agw-model-nameline">
        <span
          className="agw-model-name"
          title={
            opt.label === opt.model
              ? `${opt.providerName} · ${opt.label}`
              : `${opt.providerName} · ${opt.label}\n${opt.model}`
          }
        >
          {opt.label}
        </span>
        {showProvider && <span className="agw-model-sub">{opt.providerName}</span>}
      </span>
    </span>
    {/* Glyphs mark EXCEPTIONS only. Tool support is true of nearly every row,
        so it carries no information here and no longer draws; vision, picture
        models, editing and a Fast lane that is on still do. */}
    <span className="agw-model-controls">
      {opt.image && (
        <AgentIcon
          name="image"
          size={13}
          title="Makes pictures. Replies with an image; reads no history."
          className="agw-model-cap"
        />
      )}
      {opt.canEdit && (
        <AgentIcon
          name="pencil"
          size={13}
          title="Can also change an existing picture, not only make a new one."
          className="agw-model-cap"
        />
      )}
      {opt.vision && (
        <AgentIcon name="eye" size={13} title="Accepts image input" className="agw-model-cap" />
      )}
      {fastOn && (
        <AgentIcon name="bolt" size={12} title="Fast is on" className="agw-model-cap" />
      )}
      {selected && <AgentIcon name="check" size={15} className="agw-model-check" />}
    </span>
  </div>
);
