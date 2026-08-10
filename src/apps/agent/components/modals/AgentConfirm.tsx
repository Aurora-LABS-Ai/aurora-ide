/**
 * Agent Window — confirmation dialog [view].
 *
 * A small, themed yes/no modal for destructive or otherwise irreversible
 * actions (e.g. permanently deleting an archived chat). Portaled into
 * `.agw-root` so the `--agw-*` tokens cascade. Esc cancels, Enter confirms;
 * the confirm button is focused on open so a keyboard user can act immediately.
 */

import React, { useEffect } from "react";
import { createPortal } from "react-dom";

export interface AgentConfirmProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tints the confirm button as destructive (red). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const AgentConfirm: React.FC<AgentConfirmProps> = ({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}) => {
  const portalTarget =
    typeof document !== "undefined"
      ? (document.querySelector(".agw-root") as HTMLElement) ?? document.body
      : null;

  // Esc cancels, Enter confirms — only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open || !portalTarget) return null;

  return createPortal(
    <div className="agw-confirm-overlay" onClick={onCancel}>
      <div
        className="agw-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agw-confirm-title">{title}</div>
        <div className="agw-confirm-msg">{message}</div>
        <div className="agw-confirm-actions">
          <button type="button" className="agw-confirm-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`agw-confirm-btn agw-confirm-primary${
              destructive ? " agw-confirm-danger" : ""
            }`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

export default AgentConfirm;
