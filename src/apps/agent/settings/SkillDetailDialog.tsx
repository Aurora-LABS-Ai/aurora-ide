/**
 * Agent Window — one skill, opened from its card.
 *
 * The card says what a skill is for in one line; this says the rest: where it
 * lives, what triggers it, and the playbook itself, with the equip switch at
 * the top and delete at the foot. A dialog rather than a page because a skill
 * is read and closed — the catalog it came from should still be there behind
 * it, scrolled to where it was.
 *
 * Chrome is the confirmation dialog's (`.agw-confirm-overlay`), so every
 * modal in the window shares one scrim, one blur and one edge.
 */

import React, { useEffect } from "react";
import { createPortal } from "react-dom";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import type { SkillDefinition, SkillSource } from "@/apps/agent/services/skills/skills";
import { AgwSwitch } from "./primitives";

const SOURCE_LABEL: Record<SkillSource, { label: string; icon: AgentIconName }> = {
  workspace: { label: "Project skill", icon: "folder" },
  global: { label: "Global skill", icon: "browser" },
  builtin: { label: "Built-in skill", icon: "book" },
};

export const SkillDetailDialog: React.FC<{
  skill: SkillDefinition;
  enabled: boolean;
  /** The loadout is full or skills are off: the switch shows but cannot turn on. */
  disabled: boolean;
  onToggle: (next: boolean) => void;
  /** Absent when nothing of this skill's own is on disk to remove. */
  onDelete?: () => void;
  onClose: () => void;
}> = ({ skill, enabled, disabled, onToggle, onDelete, onClose }) => {
  const portalTarget =
    typeof document !== "undefined"
      ? ((document.querySelector(".agw-root") as HTMLElement | null) ?? document.body)
      : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!portalTarget) return null;
  const source = SOURCE_LABEL[skill.source];
  const titleId = `agw-skill-dialog-${skill.storageKey}`;

  return createPortal(
    <div className="agw-confirm-overlay" onClick={onClose}>
      <div
        className="agw-confirm-dialog agw-skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agw-skill-dialog-head">
          <span className="agw-skill-dialog-badge">
            <AgentIcon name={source.icon} size={13} />
            {source.label}
          </span>
          <span className="agw-skill-dialog-tools">
            <label className="agw-skill-dialog-equip" title={enabled ? "Equipped" : "Equip"}>
              <AgwSwitch
                checked={enabled}
                onChange={onToggle}
                ariaLabel={enabled ? `Unequip ${skill.name}` : `Equip ${skill.name}`}
                disabled={disabled && !enabled}
              />
              <span>{enabled ? "Equipped" : "Equip"}</span>
            </label>
            <button
              type="button"
              className="agw-prov-icon-btn"
              aria-label="Close"
              title="Close (Esc)"
              onClick={onClose}
            >
              <AgentIcon name="close" size={14} />
            </button>
          </span>
        </header>

        <h2 id={titleId} className="agw-skill-dialog-title">
          {skill.name}
        </h2>
        {skill.description && <p className="agw-skill-dialog-desc">{skill.description}</p>}

        <dl className="agw-skill-dialog-meta">
          <dt>Id</dt>
          <dd>
            <code>{skill.id}</code>
          </dd>
          {skill.sourcePath && (
            <>
              <dt>Path</dt>
              <dd>
                <code>{skill.sourcePath}</code>
              </dd>
            </>
          )}
          {skill.triggers.length > 0 && (
            <>
              <dt>Triggers</dt>
              <dd className="agw-skill-dialog-triggers">
                {skill.triggers.map((trigger) => (
                  <span key={trigger} className="agw-mcp-tool">
                    {trigger}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>

        <pre className="agw-skill-dialog-body agw-scroll">{skill.content}</pre>

        {onDelete && (
          <footer className="agw-skill-dialog-foot">
            <button type="button" className="agw-skill-dialog-delete" onClick={onDelete}>
              <AgentIcon name="trash" size={13} />
              Delete from disk
            </button>
          </footer>
        )}
      </div>
    </div>,
    portalTarget,
  );
};
