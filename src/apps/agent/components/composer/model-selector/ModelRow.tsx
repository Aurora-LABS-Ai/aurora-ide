/**
 * Agent Window — one pickable row in the model list [view].
 *
 * Name, the reasoning it would run at as a grey word, the provider where no
 * section header states it, a glyph only where the model is the exception, the
 * check on the one you are using, and `›` when it has reasoning to change.
 * Clicking the row picks it as it stands; `›`, resting on the row, or → opens
 * its reasoning list beside the menu (`EffortFlyout`). The row itself holds no
 * control, so the list stays a real listbox the arrow keys and a screen reader
 * can walk.
 *
 * Probe: Documents/aurora-model-picker-rows-designs.html, card 04 (picked).
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
  /** The current reasoning choice, e.g. "High" or "Thinking". */
  effort: string | null;
  /** It has reasoning (or a Fast lane) to change, so it gets a `›`. */
  hasSettings: boolean;
  /** Its reasoning list is the one open. */
  settingsOpen: boolean;
  /** Cursor's faster lane is on for this model — an exception worth marking. */
  fastOn: boolean;
  onPoint: () => void;
  onPick: () => void;
  onOpenSettings: () => void;
}> = ({
  opt,
  id,
  selected,
  active,
  showProvider,
  effort,
  hasSettings,
  settingsOpen,
  fastOn,
  onPoint,
  onPick,
  onOpenSettings,
}) => (
  <div
    id={id}
    role="option"
    aria-selected={selected}
    aria-haspopup={hasSettings ? "listbox" : undefined}
    aria-expanded={hasSettings ? settingsOpen : undefined}
    // Not a Tab stop: the search box owns focus and the arrow keys move
    // between rows. A Tab stop per row meant forty presses to cross the list.
    tabIndex={-1}
    className="agw-model-item"
    data-active={selected || undefined}
    data-kbd-active={active || undefined}
    data-settings-open={settingsOpen || undefined}
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
        {effort && <span className="agw-model-effort">{effort}</span>}
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
      {hasSettings && (
        <span
          className="agw-model-more"
          aria-hidden="true"
          title="Reasoning"
          onClick={(e) => {
            // Opens the list; picking stays the row's own click.
            e.stopPropagation();
            onOpenSettings();
          }}
        >
          <AgentIcon name="chevron-right" size={13} />
        </span>
      )}
    </span>
  </div>
);
