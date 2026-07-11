import React, { useState } from "react";
import { ClipboardList, Users, Wrench } from "lucide-react";
import type { AgentExecutionMode } from "../../services/agent-execution-mode";

interface AgentExecutionModeToggleProps {
  mode: AgentExecutionMode;
  /** Advance to the next mode in the cycle (Agent → Plan → [Team] → …). */
  onToggle: () => void;
}

const META: Record<
  AgentExecutionMode,
  { label: string; color: string; Icon: typeof Wrench; title: string }
> = {
  agent: {
    label: "Agent",
    color: "var(--aurora-common-primary)",
    Icon: Wrench,
    title: "Agent mode — implement changes with tools. Click to switch.",
  },
  plan: {
    label: "Plan",
    color: "var(--aurora-common-warning)",
    Icon: ClipboardList,
    title: "Plan mode — read & propose only. Click to switch.",
  },
  team: {
    label: "Team",
    color: "var(--aurora-common-success)",
    Icon: Users,
    title:
      "Team mode — you lead an agent team; the Lead can convene & run a team. Click to switch.",
  },
};

export const AgentExecutionModeToggle: React.FC<
  AgentExecutionModeToggleProps
> = ({ mode, onToggle }) => {
  const [isHovered, setIsHovered] = useState(false);
  const meta = META[mode] ?? META.agent;
  const Icon = meta.Icon;

  // Wrapperless: no border, no fill — only the inline text/icon carries the
  // mode tint. Hover bumps the tint slightly so it still reads as clickable.
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={meta.title}
      className="inline-flex h-6 items-center gap-1 px-1 text-[10.5px] font-semibold tracking-tight transition-opacity outline-none focus:outline-none"
      style={{
        color: meta.color,
        background: "transparent",
        border: "none",
        opacity: isHovered ? 1 : 0.85,
      }}
    >
      <Icon size={11} />
      <span>{meta.label}</span>
    </button>
  );
};

export default AgentExecutionModeToggle;
