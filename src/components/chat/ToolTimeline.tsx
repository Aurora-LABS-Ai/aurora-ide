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

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import type { ToolCall, ToolProposal } from "../../types";
import { ToolItem } from "./tool-timeline/ToolItem";
import { TOOL_GROUP_MIN } from "./tool-timeline/grouping";

interface ToolTimelineProps {
  tools: ToolCall[];
  variant?: "timeline" | "cards";
  isActivelyStreaming?: boolean;
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}

const ToolGroup: React.FC<ToolTimelineProps> = ({
  tools,
  variant = "timeline",
  isActivelyStreaming = false,
  pendingApproval = null,
  onApprovePending,
  onRejectPending,
  onApprovePendingRemember,
}) => {
  const stats = useMemo(() => {
    let complete = 0;
    let failed = 0;
    let running = 0;
    for (const tool of tools) {
      if (tool.status === "complete") complete += 1;
      else if (tool.status === "failed" || tool.status === "rejected") failed += 1;
      else running += 1;
    }
    return { complete, failed, running };
  }, [tools]);
  const [openState, setOpenState] = useState<{
    mode: "hidden" | "shown" | null;
    streaming: boolean;
  }>({ mode: null, streaming: isActivelyStreaming });

  const mode =
    openState.streaming === isActivelyStreaming ? openState.mode : null;
  const isOpen = isActivelyStreaming
    ? mode !== "hidden"
    : mode === "shown";

  const toggleOpen = () => {
    setOpenState({
      mode: isOpen ? (isActivelyStreaming ? "hidden" : null) : "shown",
      streaming: isActivelyStreaming,
    });
  };

  return (
    <div className="group relative flex gap-3">
      <div className="flex w-4 flex-shrink-0 flex-col items-center relative">
        <div className="absolute top-0 bottom-0 w-px bg-border/20" />
        <div className="relative z-10 mt-2.5 h-3 w-3 rounded-full bg-success/20 ring-2 ring-success/10" />
      </div>
      <div className="min-w-0 flex-1 pt-1 pb-1">
        <button
          onClick={toggleOpen}
          className="group/header flex min-w-0 items-center gap-2 py-1 text-left outline-none"
        >
          <ChevronRight
            size={13}
            className={`flex-shrink-0 text-text-disabled transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
          />
          <span className="text-[10.5px] text-text-disabled transition-colors group-hover/header:text-text-secondary">
            {tools.length} calls · {stats.complete} done
          </span>
          {stats.failed > 0 && (
            <span className="rounded-full border border-warning/35 bg-warning/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-warning">
              {stats.failed} failed
            </span>
          )}
        </button>

        <motion.div
          initial={false}
          animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="overflow-hidden"
        >
          <div className="pt-1">
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
        </motion.div>
      </div>
    </div>
  );
};

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
  if (tools.length >= TOOL_GROUP_MIN) {
    return (
      <div className="w-full pl-2">
        <ToolGroup
          tools={tools}
          variant={variant}
          isActivelyStreaming={isActivelyStreaming}
          pendingApproval={pendingApproval}
          onApprovePending={onApprovePending}
          onRejectPending={onRejectPending}
          onApprovePendingRemember={onApprovePendingRemember}
        />
      </div>
    );
  }

  return (
    <div className="w-full pl-2">
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
