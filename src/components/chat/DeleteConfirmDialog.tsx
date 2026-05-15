/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * See: DOCS/theme-dev.md for full token reference.
 */

import React from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";

interface DeleteConfirmDialogProps {
  isOpen: boolean;
  /** @deprecated Use itemName instead */
  threadTitle?: string;
  /** Name of the item to delete */
  itemName?: string;
  /** Type of item being deleted (for display text) */
  itemType?: "conversation" | "file" | "folder" | "server";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Thin wrapper around the generalized [`ConfirmDialog`] with the
 * delete-specific copy bundled in. Kept for source-compat with the
 * three pre-existing call sites (TreeNode, ThreadHistory, McpSettingsTab) —
 * new code should call `ConfirmDialog` directly with `variant="danger"`.
 */
export const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  isOpen,
  threadTitle,
  itemName,
  itemType = "conversation",
  onConfirm,
  onCancel,
}) => {
  const displayName = itemName ?? threadTitle ?? "";

  const typeLabels = {
    conversation: {
      title: "Delete conversation",
      label: "Conversation",
      fallback: "Untitled conversation",
    },
    file: {
      title: "Delete file",
      label: "File",
      fallback: "Untitled file",
    },
    folder: {
      title: "Delete folder",
      label: "Folder",
      fallback: "Untitled folder",
    },
    server: {
      title: "Remove MCP server",
      label: "Server",
      fallback: "Unnamed server",
    },
  };

  const labels = typeLabels[itemType];

  return (
    <ConfirmDialog
      isOpen={isOpen}
      variant="danger"
      title={labels.title}
      description={`This action cannot be undone.`}
      details={{
        label: labels.label,
        value: displayName || labels.fallback,
      }}
      confirmLabel={itemType === "server" ? "Remove" : "Delete"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
};
