import React, { useState } from "react";
import { ClipboardList, Wrench } from "lucide-react";
import type { AgentExecutionMode } from "../../services/agent-execution-mode";

interface AgentExecutionModeToggleProps {
  mode: AgentExecutionMode;
  onToggle: () => void;
}

export const AgentExecutionModeToggle: React.FC<
  AgentExecutionModeToggleProps
> = ({ mode, onToggle }) => {
  const isPlanMode = mode === "plan";
  const Icon = isPlanMode ? ClipboardList : Wrench;
  const [isHovered, setIsHovered] = useState(false);

  // Wrapperless: no border, no fill — only the inline text/icon carries the
  // mode tint. Hover bumps the tint slightly so it still reads as clickable.
  const baseColor = isPlanMode
    ? "var(--aurora-common-warning)"
    : "var(--aurora-common-primary)";

  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={
        isPlanMode
          ? "Plan mode — read & propose only. Click to switch to Agent."
          : "Agent mode — implement changes with tools. Click to switch to Plan."
      }
      className="inline-flex h-6 items-center gap-1 px-1 text-[10.5px] font-semibold tracking-tight transition-opacity outline-none focus:outline-none"
      style={{
        color: baseColor,
        background: "transparent",
        border: "none",
        opacity: isHovered ? 1 : 0.85,
      }}
    >
      <Icon size={11} />
      <span>{isPlanMode ? "Plan" : "Agent"}</span>
    </button>
  );
};

export default AgentExecutionModeToggle;
