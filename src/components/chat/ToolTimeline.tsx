/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * Use theme tokens via CSS variables (e.g. `bg-[var(--aurora-editor-background)]`).
 * See: DOCS/theme-dev.md / src/types/theme.ts / src/services/theme-service.ts
 *
 * IMPLEMENTATION NOTE:
 *
 * The per-tool rendering logic lives in `./tool-timeline/`:
 *   - `ToolItem.tsx`           — one card per tool call
 *   - `useToolResultParser.ts` — converts raw JSON results to per-view data
 *   - `views/*`                — one file per rich renderer (workspace_tree,
 *                                grep, web search, browser scroll, code,
 *                                shell output, multi-file read, file list)
 *   - `salvage.ts`             — best-effort recovery for truncated JSON
 *                                tool results loaded from the JSONL log
 *   - `helpers.ts`, `types.ts`, `open-file.ts`, `ExplorerFileAssetIcon.tsx`
 */

import React from "react";
import type { ToolCall, ToolProposal } from "../../types";
import { ToolItem } from "./tool-timeline/ToolItem";

interface ToolTimelineProps {
  tools: ToolCall[];
  variant?: "timeline" | "cards";
  isActivelyStreaming?: boolean;
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}

/**
 * Vertical timeline of tool calls for a single assistant message. Each
 * `ToolItem` is self-contained — see `tool-timeline/ToolItem.tsx` for
 * the per-card layout and the rich-result routing.
 */
export const ToolTimeline: React.FC<ToolTimelineProps> = ({
  tools,
  variant = "timeline",
  isActivelyStreaming = false,
  pendingApproval = null,
  onApprovePending,
  onRejectPending,
  onApprovePendingRemember,
}) => {
  if (!tools || tools.length === 0) return null;

  return (
    <div className="w-full mt-2 pl-2">
      {tools.map((tool, idx) => (
        <ToolItem
          key={`${variant}-${tool.id}`}
          tool={tool}
          isLast={idx === tools.length - 1}
          index={idx}
          isActivelyStreaming={isActivelyStreaming}
          pendingApproval={pendingApproval}
          onApprovePending={onApprovePending}
          onRejectPending={onRejectPending}
          onApprovePendingRemember={onApprovePendingRemember}
        />
      ))}
    </div>
  );
};
