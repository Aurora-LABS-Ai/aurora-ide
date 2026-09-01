/**
 * Agent Window — Settings · Tools & Approvals (view).
 *
 * agw-native rebuild of the IDE's Tool settings, reading/writing the SAME shared
 * `useSettingsStore` (one source of truth, just a different dress).
 *
 * Layout (modelled on the Studio tools sub-page): defaults/guardrails as a tile
 * grid, then per-tool approval as COLLAPSIBLE group panels — all collapsed by
 * default so it's not a wall of rows. Each group expands to its tools (with
 * Auto/Ask/Deny per tool) and carries bulk actions for the whole family.
 */

import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { useSettingsStore, type WorkspaceAccess } from "@/kernel/store/useSettingsStore";
import { getProfessionalToolName } from "@/apps/agent/services/tools/tool-display";
import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { ShellSettings } from "./ShellSettings";
import {
  AgwPill,
  AgwSegmented,
  AgwSwitch,
  SettingsRow,
  SettingsSection,
  type SegmentOption,
} from "./primitives";

type ApprovalMode = "auto" | "always_ask" | "deny";

const APPROVAL_OPTIONS: SegmentOption<ApprovalMode>[] = [
  { value: "auto", label: "Auto", tone: "success" },
  { value: "always_ask", label: "Ask", tone: "warning" },
  { value: "deny", label: "Deny", tone: "danger" },
];

const ACCESS_OPTIONS: SegmentOption<WorkspaceAccess>[] = [
  { value: "workspace", label: "Project only" },
  { value: "read", label: "Read anywhere", tone: "warning" },
  { value: "full", label: "Full access", tone: "danger" },
];

/** What each mode actually permits, in the order someone widens it. */
const ACCESS_HINT: Record<WorkspaceAccess, string> = {
  workspace: "The agent reads, searches, and writes only inside the open project. Anything else is refused.",
  read: "The agent can also open a file you point it to by absolute path. Searching and writing still stay inside the project.",
  full: "No path limit. Reading, searching, and writing all work anywhere on this computer — for a second checkout, a dependency's source, or a config outside the project. Approval prompts still apply to writes, deletes, and shell commands.",
};

interface ToolCategory {
  label: string;
  icon: AgentIconName;
  tools: string[];
  dangerous?: boolean;
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  shell: {
    label: "Shell Commands",
    icon: "terminal",
    dangerous: true,
    tools: ["shell_execute", "shell_spawn"],
  },
  fileWrite: {
    label: "File Modifications",
    icon: "diff",
    dangerous: true,
    tools: ["file_write", "file_edit", "move_path", "delete_path", "folder_create"],
  },
  browserInteract: {
    label: "Browser · Interaction",
    icon: "inspect",
    dangerous: true,
    tools: ["browser_navigate", "browser_click", "browser_fill", "browser_scroll"],
  },
};

// ── A compact toggle tile (defaults / guardrails) ────────────────────────────

const ToggleTile: React.FC<{
  icon: AgentIconName;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tone?: "accent" | "success";
}> = ({ icon, label, hint, checked, onChange, tone = "accent" }) => (
  <div className="agw-set-tile">
    <div className="agw-set-tile-top">
      <span className="agw-set-tile-ico">
        <AgentIcon name={icon} size={15} />
      </span>
      <span className="agw-set-tile-label">{label}</span>
      <AgwSwitch checked={checked} onChange={onChange} tone={tone} ariaLabel={label} />
    </div>
    <div className="agw-set-tile-hint">{hint}</div>
  </div>
);

// ── A collapsible category group ─────────────────────────────────────────────

const ToolGroup: React.FC<{
  category: ToolCategory;
  open: boolean;
  settings: Record<string, ApprovalMode>;
  onToggleOpen: () => void;
  onSetTool: (tool: string, mode: ApprovalMode) => void;
  onSetAll: (mode: ApprovalMode) => void;
}> = ({ category, open, settings, onToggleOpen, onSetTool, onSetAll }) => {
  // Summary: how many tools sit at each mode (drives the "all auto / mixed" hint).
  const modes = category.tools.map((t) => settings[t] || "always_ask");
  const autoCount = modes.filter((m) => m === "auto").length;
  const denyCount = modes.filter((m) => m === "deny").length;
  const summary =
    autoCount === modes.length
      ? "All auto"
      : denyCount === modes.length
        ? "All denied"
        : `${category.tools.length} tools`;

  return (
    <div className="agw-set-group" data-open={open || undefined}>
      <button type="button" className="agw-set-group-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className="agw-set-group-chev" data-open={open || undefined}>
          <AgentIcon name="chevron-down" size={15} />
        </span>
        <span className="agw-set-group-ico">
          <AgentIcon name={category.icon} size={15} />
        </span>
        <span className="agw-set-group-title">{category.label}</span>
        <span className="agw-set-group-meta">{summary}</span>
        {category.dangerous ? (
          <AgwPill tone="danger">High risk</AgwPill>
        ) : (
          <AgwPill tone="neutral">Read-only</AgwPill>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-set-group-body">
              {category.tools.map((tool) => (
                <div key={tool} className="agw-set-trow">
                  <span className="agw-set-trow-name" title={tool}>
                    {getProfessionalToolName(tool)}
                  </span>
                  <AgwSegmented
                    ariaLabel={`Approval mode for ${tool}`}
                    value={settings[tool] || "always_ask"}
                    options={APPROVAL_OPTIONS}
                    onChange={(mode) => onSetTool(tool, mode)}
                  />
                </div>
              ))}
              <div className="agw-set-group-foot">
                <span className="agw-set-group-foot-label">Set all</span>
                <button type="button" className="agw-set-foot-btn" onClick={() => onSetAll("auto")}>
                  Auto
                </button>
                <button
                  type="button"
                  className="agw-set-foot-btn"
                  onClick={() => onSetAll("always_ask")}
                >
                  Ask
                </button>
                <button type="button" className="agw-set-foot-btn" onClick={() => onSetAll("deny")}>
                  Deny
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const ToolsSettings: React.FC = () => {
  const autoApproveTools = useSettingsStore((s) => s.autoApproveTools);
  const setAutoApproveTools = useSettingsStore((s) => s.setAutoApproveTools);
  const autoAcceptChanges = useSettingsStore((s) => s.autoAcceptChanges);
  const setAutoAcceptChanges = useSettingsStore((s) => s.setAutoAcceptChanges);
  const syntaxValidationEnabled = useSettingsStore((s) => s.syntaxValidationEnabled);
  const setSyntaxValidationEnabled = useSettingsStore((s) => s.setSyntaxValidationEnabled);
  const projectLayoutEnabled = useSettingsStore((s) => s.projectLayoutEnabled);
  const setProjectLayoutEnabled = useSettingsStore((s) => s.setProjectLayoutEnabled);
  const workspaceAccess = useSettingsStore((s) => s.workspaceAccess);
  const setWorkspaceAccess = useSettingsStore((s) => s.setWorkspaceAccess);
  const toolApprovalSettings = useSettingsStore((s) => s.toolApprovalSettings) as Record<
    string,
    ApprovalMode
  >;
  const setToolApproval = useSettingsStore((s) => s.setToolApproval);

  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setCategory = (key: keyof typeof TOOL_CATEGORIES, mode: ApprovalMode) =>
    TOOL_CATEGORIES[key].tools.forEach((t) => setToolApproval(t, mode));

  return (
    <div className="agw-set-wide">
      {/* Defaults & guardrails */}
      <section className="agw-set-section">
        <header className="agw-set-section-head">
          <div className="agw-set-section-title-wrap">
            <span className="agw-set-section-ico">
              <AgentIcon name="shield" size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h3 className="agw-set-section-title">Defaults & Guardrails</h3>
              <p className="agw-set-section-desc">
                Global behavior and quality checks. Auto-approve overrides the per-tool rules below.
              </p>
            </div>
          </div>
          {autoApproveTools && <AgwPill tone="warning">Auto-approve on</AgwPill>}
        </header>

        <div className="agw-set-tiles">
          <ToggleTile
            icon="shield"
            label="Auto-approve all tools"
            hint="Run every tool without asking. Per-tool rules are ignored while on."
            checked={autoApproveTools}
            onChange={setAutoApproveTools}
          />
          <ToggleTile
            icon="diff"
            label="Auto-accept file changes"
            hint="Skip diff review and apply file modifications immediately."
            checked={autoAcceptChanges}
            onChange={setAutoAcceptChanges}
          />
          <ToggleTile
            icon="check"
            label="Pre-save syntax validation"
            hint="Reject writes with syntax errors; the agent must fix and retry."
            checked={syntaxValidationEnabled}
            onChange={setSyntaxValidationEnabled}
            tone="success"
          />
          <ToggleTile
            icon="files"
            label="Project file map"
            hint="Inject a workspace tree into the first message so the agent knows the layout."
            checked={projectLayoutEnabled}
            onChange={setProjectLayoutEnabled}
            tone="success"
          />
        </div>
      </section>

      {autoApproveTools && (
        <div className="agw-set-notice" data-tone="warning">
          <span>
            Global auto-approve is on — the per-tool rules below are ignored until you turn it off.
          </span>
        </div>
      )}

      {/* Where the file tools may reach. It sits above per-tool approval
          because it decides WHAT a tool can touch, while approval decides
          whether it runs — and the narrower question is the one to answer
          first. */}
      <SettingsSection
        icon="folder"
        title="File access"
        description="How far outside the open project the file tools may reach. Shell commands are not limited by this in any mode — approval is what gates those."
        badge={
          workspaceAccess === "full" ? (
            <AgwPill tone="danger">Whole computer</AgwPill>
          ) : workspaceAccess === "read" ? (
            <AgwPill tone="warning">Reads unrestricted</AgwPill>
          ) : undefined
        }
      >
        <SettingsRow
          last
          alignTop
          label="Scope"
          hint={ACCESS_HINT[workspaceAccess]}
          searchTerms="workspace outside project boundary read write grep glob find absolute path full access"
        >
          <AgwSegmented
            ariaLabel="How far outside the project the file tools may reach"
            value={workspaceAccess}
            options={ACCESS_OPTIONS}
            onChange={setWorkspaceAccess}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Where shell commands run — decided before deciding who may run them. */}
      <ShellSettings />

      {/* Per-tool approval — collapsible groups */}
      <section className="agw-set-section">
        <header className="agw-set-section-head">
          <div className="agw-set-section-title-wrap">
            <span className="agw-set-section-ico">
              <AgentIcon name="sliders" size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h3 className="agw-set-section-title">Per-tool Approval</h3>
              <p className="agw-set-section-desc">
                Click a group to expand. Auto runs the tool, Ask prompts you, Deny blocks it.
              </p>
            </div>
          </div>
        </header>

        <div className="agw-set-groups">
          {(Object.entries(TOOL_CATEGORIES) as [keyof typeof TOOL_CATEGORIES, ToolCategory][]).map(
            ([key, cat]) => (
              <ToolGroup
                key={key}
                category={cat}
                open={openGroups.has(key)}
                settings={toolApprovalSettings}
                onToggleOpen={() => toggleGroup(key)}
                onSetTool={setToolApproval}
                onSetAll={(mode) => setCategory(key, mode)}
              />
            ),
          )}
        </div>
      </section>
    </div>
  );
};
