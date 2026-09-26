import React, { useRef } from "react";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentUiStore, type AgentSettingsTab } from "@/apps/agent/store/ui/useAgentUiStore";
import { useSettingsQuery } from "./settings-search";
import { AgentGeneralSettings } from "./AgentGeneralSettings";
import { CodeIndexCard } from "./CodeIndexCard";

/** Reuses the category tabs from Appearance and Preferences. */
export const AgentSettings: React.FC = () => {
  const storedTab = useAgentUiStore((s) => s.agentSettingsTab);
  const setTab = useAgentUiStore((s) => s.setAgentSettingsTab);
  const tab = storedTab === "code-index" ? "code-index" : "general";
  const searching = useSettingsQuery().length > 0;
  const tabsRef = useRef<HTMLDivElement>(null);
  const select = (next: AgentSettingsTab) => {
    setTab(next);
    tabsRef.current?.closest(".agw-settings-content")?.scrollTo({ top: 0 });
  };
  const tabs = [{ id: "general", label: "General", icon: "settings" }, { id: "code-index", label: "Code index", icon: "workspace-tree" }] as const;
  return <div className="agw-set-wide">
    {!searching && <div ref={tabsRef} className="agw-set-tabs" role="tablist" aria-label="Agent categories"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "general" : event.key === "End" ? "code-index" : tab === "general" ? "code-index" : "general";
        select(next);
        tabsRef.current?.querySelector<HTMLButtonElement>(`#agw-agent-tab-${next}`)?.focus();
      }}>
      {tabs.map((item) => <button key={item.id} type="button" role="tab" id={`agw-agent-tab-${item.id}`}
        aria-selected={tab === item.id} aria-controls={`agw-agent-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
        className="agw-set-tab" data-selected={tab === item.id || undefined} onClick={() => select(item.id)}>
        <AgentIcon name={item.icon} size={14} /><span>{item.label}</span>
      </button>)}
    </div>}
    <div className="agw-set-tabpanel" {...(searching ? {} : { role: "tabpanel", id: `agw-agent-panel-${tab}`, "aria-labelledby": `agw-agent-tab-${tab}` })}>
      {(searching || tab === "general") && <AgentGeneralSettings />}
      {(searching || tab === "code-index") && <CodeIndexCard />}
    </div>
  </div>;
};
