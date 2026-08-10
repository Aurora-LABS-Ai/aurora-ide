/**
 * Agent Window — tool approval bar [view].
 *
 * The window has no modal layer, so an `always_ask` tool surfaces an inline
 * approval strip docked just above the composer: the tool name, a one-line
 * argument preview, and Approve / Always / Reject. Resolving it unblocks the
 * runtime (see `useAgentWindowSend`). All colour comes from `--agw-*`.
 */

import React, { useMemo } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";

interface ApprovalBarProps {
  toolName: string;
  /** Raw JSON arguments (provider format). */
  args: string;
  onApprove: () => void;
  onApproveAlways: () => void;
  onReject: () => void;
}

/** Collapse the JSON args into a single readable line for the preview. */
function previewArgs(args: string): string {
  try {
    const parsed = JSON.parse(args || "{}");
    if (parsed && typeof parsed === "object") {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 0) return "";
      return entries
        .map(([k, v]) => `${k}: ${String(typeof v === "object" ? JSON.stringify(v) : v)}`)
        .join("  ·  ");
    }
  } catch {
    /* fall through to raw */
  }
  return args.replace(/\s+/g, " ").trim();
}

export const ApprovalBar: React.FC<ApprovalBarProps> = ({
  toolName,
  args,
  onApprove,
  onApproveAlways,
  onReject,
}) => {
  const preview = useMemo(() => previewArgs(args), [args]);

  return (
    <div
      className="w-full max-w-3xl mx-auto"
      style={{
        marginBottom: 8,
        padding: "10px 12px",
        borderRadius: 12,
        background: "var(--agw-surface-elevated)",
        border: "1px solid var(--agw-border-strong)",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ color: "var(--agw-accent)", display: "inline-flex", flexShrink: 0 }}>
        <AgentIcon name="review" size={16} />
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: "var(--agw-fs-ui)", fontWeight: "var(--agw-fw-medium)", color: "var(--agw-text)" }}>
          Run <span className="agw-code">{toolName}</span>?
        </div>
        {preview && (
          <div
            className="agw-code"
            style={{
              fontSize: "var(--agw-fs-label)",
              color: "var(--agw-text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={preview}
          >
            {preview}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button type="button" className="agw-btn-ghost" onClick={onReject}>
          Reject
        </button>
        <button type="button" className="agw-btn-ghost" onClick={onApproveAlways}>
          Always
        </button>
        <button type="button" className="agw-btn-primary" onClick={onApprove}>
          Approve
        </button>
      </div>
    </div>
  );
};
