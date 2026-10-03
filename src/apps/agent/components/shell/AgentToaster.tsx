/**
 * Agent Window — where toasts appear [view].
 *
 * Mounted once at the window root (`AgentWindow`), so every page, panel and
 * modal shares one place for "that worked" — bottom centre, over everything,
 * out of the layout. Content comes from `useAgentToastStore`; call `toast()`.
 *
 * The live region stays mounted whether or not a toast is showing, so a
 * screen reader announces each new one. Errors are announced assertively.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentToastStore } from "@/apps/agent/store/ui/useAgentToastStore";

export const AgentToaster: React.FC = () => {
  const toasts = useAgentToastStore((s) => s.toasts);
  const urgent = toasts.some((entry) => entry.tone === "error");
  return (
    <div
      className="agw-toaster"
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      {toasts.map((entry) => (
        <div
          key={entry.id}
          className="agw-toast"
          data-tone={entry.tone}
          style={{ "--agw-toast-duration": `${entry.duration}ms` } as React.CSSProperties}
        >
          {entry.icon && <AgentIcon name={entry.icon} size={14} />}
          <span>{entry.text}</span>
        </div>
      ))}
    </div>
  );
};
