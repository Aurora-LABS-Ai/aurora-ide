/**
 * Agent Window — microphone consent modal [view].
 *
 * The agent window's own "Allow microphone access" gate, shown the first time
 * the user taps the composer mic (and any time after they clear the remembered
 * choice). It stands in for the WebView's raw, browser-style permission prompt —
 * which is suppressed natively (see `install_agent_media_permission_handler`) so
 * this is the ONLY microphone prompt the user sees.
 *
 * Built from `--agw-*` tokens and portaled into `.agw-root`, so it reads as part
 * of the agent window, not the IDE. Esc dismisses, Enter allows; the primary
 * action is focused on open for immediate keyboard use.
 *
 * Mounted only while open (by the composer), so `remember` starts fresh each
 * time without a reset effect.
 */

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "../shared/AgentIcon";

export interface AgentMicPermissionModalProps {
  /** User granted access — `remember` persists the choice so we stop asking. */
  onAllow: (remember: boolean) => void;
  /** User dismissed without granting. */
  onDismiss: () => void;
}

export const AgentMicPermissionModal: React.FC<AgentMicPermissionModalProps> = ({
  onAllow,
  onDismiss,
}) => {
  const [remember, setRemember] = useState(true);

  const portalTarget =
    typeof document !== "undefined"
      ? (document.querySelector(".agw-root") as HTMLElement) ?? document.body
      : null;

  // Esc dismisses, Enter allows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onAllow(remember);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAllow, onDismiss, remember]);

  if (!portalTarget) return null;

  return createPortal(
    <div className="agw-mic-perm-overlay" onClick={onDismiss}>
      <div
        className="agw-mic-perm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Allow microphone access"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agw-mic-perm-badge" aria-hidden>
          <AgentIcon name="mic" size={20} />
        </div>

        <div className="agw-mic-perm-title">Allow microphone access</div>
        <div className="agw-mic-perm-msg">
          Aurora records audio to transcribe what you say into the composer.
          Everything is processed locally by your configured speech engine —
          nothing is uploaded.
        </div>

        <label className="agw-mic-perm-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Remember this choice on this machine</span>
        </label>

        <div className="agw-mic-perm-actions">
          <button type="button" className="agw-mic-perm-btn" onClick={onDismiss}>
            Not now
          </button>
          <button
            type="button"
            className="agw-mic-perm-btn agw-mic-perm-primary"
            onClick={() => onAllow(remember)}
            autoFocus
          >
            Allow microphone
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

export default AgentMicPermissionModal;
