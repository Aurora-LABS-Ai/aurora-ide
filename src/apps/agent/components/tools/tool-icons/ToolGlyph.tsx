/**
 * Agent Window — a tool row's mark, in the chosen drawing set [view].
 *
 * Use this wherever a TOOL's mark is drawn (the tool card header and its
 * running scan copy, the grouped-run header). Everything else in the window
 * keeps calling AgentIcon directly: the opt-in set restyles tool rows only.
 */

import React from "react";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { toolMarkGlyph } from "./tool-icon-sets";

export const ToolGlyph: React.FC<{
  name: AgentIconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}> = ({ name, size, className, style }) => {
  const setId = useAgentThemeStore((s) => s.toolIconSet);
  const glyph = toolMarkGlyph(setId, name);
  return (
    <AgentIcon
      name={name}
      size={size}
      className={className}
      style={style}
      glyph={glyph ?? undefined}
    />
  );
};
