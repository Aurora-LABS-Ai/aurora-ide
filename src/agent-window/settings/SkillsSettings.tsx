/**
 * Agent Window — Settings · Skills (view).
 *
 * agw-native. Reads/writes the SAME shared `useSettingsStore` skill toggles the
 * IDE uses, so equipping a skill here equips it for the agent everywhere.
 * Enablement is **per workspace**: capacity, cap, and toggles are all scoped to
 * the currently-open project (`useAgentChatStore.projectRoot`).
 *
 * Design — a "workspace loadout":
 *   1. Hero panel: capacity meter (n / 10) + master switch. The loadout is the
 *      headline, not an afterthought.
 *   2. Equipped strip: removable chips for what's currently active, so the
 *      selection is tangible and editable in one place.
 *   3. Catalog: source-filtered card grid (All / Project / Global / Built-in)
 *      where each card is a single click to equip / unequip. This is also the
 *      only surface that exposes the built-in skills, which are otherwise
 *      unreachable (default-off + never listed in the old UI).
 *
 * Palette: green = equipped (matches the master switch + on cues), amber when
 * the loadout is full. Accent stays out of it.
 */

import React, { useEffect, useMemo, useState } from "react";

import { useSettingsStore } from "../../store/useSettingsStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import {
  getBuiltinSkills,
  getResolvedGlobalSkillsPath,
  getSkillToggleScopeKey,
  getWorkspaceSkillToggles,
  isSkillEnabled,
  loadGlobalSkills,
  loadWorkspaceSkills,
  MAX_ENABLED_SKILLS,
  WORKSPACE_SKILL_FOLDERS,
  type SkillDefinition,
  type SkillSource,
} from "../../services/skills";
import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { AgwButton, AgwSegmented, AgwSwitch, AgwTextInput } from "./primitives";

type SourceFilter = "all" | "project" | "global" | "builtin";

const SOURCE_META: Record<
  SkillSource,
  { label: string; icon: AgentIconName }
> = {
  workspace: { label: "Project", icon: "folder" },
  global: { label: "Global", icon: "browser" },
  builtin: { label: "Built-in", icon: "book" },
};

const matchesQuery = (skill: SkillDefinition, query: string): boolean => {
  if (!query) return true;
  const haystack = [skill.id, skill.name, skill.description, ...skill.triggers]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
};

const matchesSource = (skill: SkillDefinition, filter: SourceFilter): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "project":
      return skill.source === "workspace";
    case "global":
      return skill.source === "global";
    case "builtin":
      return skill.source === "builtin";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
};

// ── Skill card (whole card is the equip toggle) ──────────────────────────────

const SkillCard: React.FC<{
  skill: SkillDefinition;
  enabled: boolean;
  disabled: boolean;
  onToggle: (skill: SkillDefinition, next: boolean) => void;
}> = ({ skill, enabled, disabled, onToggle }) => {
  const meta = SOURCE_META[skill.source];
  return (
    <button
      type="button"
      className="agw-skill-card"
      data-on={enabled || undefined}
      data-disabled={disabled || undefined}
      aria-pressed={enabled}
      disabled={disabled}
      onClick={() => onToggle(skill, !enabled)}
      title={enabled ? `Unequip ${skill.name}` : `Equip ${skill.name}`}
    >
      <span className="agw-skill-card-check" aria-hidden={!enabled}>
        {enabled && <AgentIcon name="check" size={12} />}
      </span>
      <span className="agw-skill-card-badge">
        <AgentIcon name={meta.icon} size={12} />
        {meta.label}
      </span>
      <span className="agw-skill-card-name">{skill.name}</span>
      <span className="agw-skill-card-desc">{skill.description}</span>
      <span className="agw-skill-card-foot">
        <span className="agw-skill-id" title={skill.id}>
          {skill.id}
        </span>
        {skill.triggers.length > 0 && (
          <span className="agw-skill-trig">
            {skill.triggers.length} trigger
            {skill.triggers.length === 1 ? "" : "s"}
          </span>
        )}
      </span>
    </button>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

export const SkillsSettings: React.FC = () => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const skillToggles = useSettingsStore((s) => s.skillToggles);
  const skillsEnabled = useSettingsStore((s) => s.skillsEnabled);
  const setSkillEnabled = useSettingsStore((s) => s.setSkillEnabled);
  const setSkillsEnabled = useSettingsStore((s) => s.setSkillsEnabled);

  const scopeKey = useMemo(
    () => getSkillToggleScopeKey(projectRoot),
    [projectRoot],
  );
  const workspaceToggles = useMemo(
    () => getWorkspaceSkillToggles(skillToggles, projectRoot),
    [skillToggles, projectRoot],
  );

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [projectSkills, setProjectSkills] = useState<SkillDefinition[]>([]);
  const [globalSkills, setGlobalSkills] = useState<SkillDefinition[]>([]);
  const [globalSkillsPath, setGlobalSkillsPath] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [capWarning, setCapWarning] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const builtinSkills = useMemo(() => getBuiltinSkills(), []);

  const loadSkills = async (active?: () => boolean) => {
    setIsRefreshing(true);
    try {
      const [loadedProjectSkills, resolvedGlobalPath] = await Promise.all([
        loadWorkspaceSkills(projectRoot),
        getResolvedGlobalSkillsPath(),
      ]);
      if (active && !active()) return;
      setProjectSkills(loadedProjectSkills);
      setGlobalSkillsPath(resolvedGlobalPath);
      const loadedGlobalSkills = await loadGlobalSkills(resolvedGlobalPath);
      if (active && !active()) return;
      setGlobalSkills(loadedGlobalSkills);
    } finally {
      if (!active || active()) setIsRefreshing(false);
    }
  };

  useEffect(() => {
    let isActive = true;
    void loadSkills(() => isActive);
    return () => {
      isActive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  const allSkills = useMemo(
    () => [...builtinSkills, ...projectSkills, ...globalSkills],
    [builtinSkills, projectSkills, globalSkills],
  );

  const enabledSkills = useMemo(
    () => allSkills.filter((s) => isSkillEnabled(s, workspaceToggles, true)),
    [allSkills, workspaceToggles],
  );

  const totalEnabledCount = useMemo(
    () => Object.values(workspaceToggles).filter(Boolean).length,
    [workspaceToggles],
  );
  const capReached = totalEnabledCount >= MAX_ENABLED_SKILLS;
  const meterPct = Math.min(100, (totalEnabledCount / MAX_ENABLED_SKILLS) * 100);

  const handleToggle = (skill: SkillDefinition, next: boolean) => {
    const applied = setSkillEnabled(scopeKey, skill.storageKey, next);
    if (!applied && next) {
      setCapWarning(
        `Your loadout is full (${MAX_ENABLED_SKILLS}). Unequip one before adding "${skill.name}".`,
      );
      return;
    }
    setCapWarning(null);
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleSkills = useMemo(
    () =>
      allSkills.filter(
        (skill) =>
          matchesSource(skill, sourceFilter) &&
          matchesQuery(skill, normalizedQuery),
      ),
    [allSkills, sourceFilter, normalizedQuery],
  );

  const counts = useMemo(
    () => ({
      all: allSkills.length,
      project: projectSkills.length,
      global: globalSkills.length,
      builtin: builtinSkills.length,
    }),
    [allSkills, projectSkills, globalSkills, builtinSkills],
  );

  const normalizedRoot = projectRoot ? projectRoot.replace(/\\/g, "/") : null;
  const projectFolderHints = WORKSPACE_SKILL_FOLDERS.map((folder) =>
    folder.replace(/\\/g, "/"),
  );

  return (
    <div className="agw-set-wide">
      {/* ── Hero: workspace loadout ─────────────────────────────────────── */}
      <div className="agw-skill-hero" data-off={!skillsEnabled || undefined}>
        <div className="agw-skill-hero-main">
          <div className="agw-skill-hero-eyebrow">Workspace loadout</div>
          <div className="agw-skill-hero-count">
            <b data-full={capReached || undefined}>{totalEnabledCount}</b>
            <span>/ {MAX_ENABLED_SKILLS}</span>
          </div>
          <div className="agw-skill-hero-label">
            {skillsEnabled
              ? "skills equipped for this project"
              : "skills paused — nothing is injected"}
          </div>
          <div className="agw-skill-meter" data-full={capReached || undefined}>
            <span style={{ width: `${meterPct}%` }} />
          </div>
        </div>
        <div className="agw-skill-hero-side">
          <span className="agw-skill-hero-state">
            {skillsEnabled ? "Active" : "Paused"}
          </span>
          <AgwSwitch
            checked={skillsEnabled}
            onChange={setSkillsEnabled}
            ariaLabel="Toggle skill system"
          />
        </div>
      </div>

      {capWarning && (
        <div className="agw-set-notice" data-tone="warning">
          {capWarning}
        </div>
      )}

      {/* ── Equipped strip ──────────────────────────────────────────────── */}
      <div className="agw-skill-equipped">
        <div className="agw-skill-equipped-head">
          <span>Equipped</span>
          <span className="agw-skill-equipped-hint">
            {enabledSkills.length === 0
              ? "Nothing equipped yet — pick from the catalog below."
              : "Click a chip to unequip."}
          </span>
        </div>
        {enabledSkills.length > 0 && (
          <div className="agw-skill-chips">
            {enabledSkills.map((skill) => (
              <button
                key={skill.storageKey}
                type="button"
                className="agw-skill-chip"
                onClick={() => handleToggle(skill, false)}
                title={`Unequip ${skill.name}`}
              >
                <AgentIcon name={SOURCE_META[skill.source].icon} size={11} />
                <span className="agw-skill-chip-name">{skill.name}</span>
                <AgentIcon name="close" size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Catalog ─────────────────────────────────────────────────────── */}
      <section className="agw-set-section">
        <header className="agw-set-section-head">
          <div className="agw-set-section-title-wrap">
            <span className="agw-set-section-ico">
              <AgentIcon name="files" size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h3 className="agw-set-section-title">Skill catalog</h3>
              <p className="agw-set-section-desc">
                Equip up to {MAX_ENABLED_SKILLS}. The agent can still discover and
                load any of the rest on demand.
              </p>
            </div>
          </div>
        </header>

        <div className="agw-set-panel agw-skill-catalog">
          {/* Toolbar */}
          <div className="agw-skill-toolbar">
            <AgwSegmented<SourceFilter>
              value={sourceFilter}
              onChange={setSourceFilter}
              ariaLabel="Skill source"
              options={[
                { value: "all", label: `All ${counts.all}` },
                { value: "project", label: `Project ${counts.project}` },
                { value: "global", label: `Global ${counts.global}` },
                // Aurora ships no built-in skills; its one piece of built-in
                // guidance is the surface doctrine, which is an instruction
                // rather than a catalogue entry. The filter appears only if a
                // build ever reintroduces built-ins, instead of sitting there
                // permanently reading "Built-in 0".
                ...(counts.builtin > 0
                  ? [{ value: "builtin" as const, label: `Built-in ${counts.builtin}` }]
                  : []),
              ]}
            />
            <AgwButton
              icon="retry"
              onClick={() => void loadSkills()}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </AgwButton>
          </div>

          {/* Search */}
          <div className="agw-skill-search">
            <AgentIcon
              name="search"
              size={13}
              style={{ color: "var(--agw-text-subtle)", flexShrink: 0 }}
            />
            <AgwTextInput
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills by name, id, or trigger…"
              className="agw-skill-search-input"
            />
            <span className="agw-skill-count">
              {normalizedQuery
                ? `${visibleSkills.length} / ${counts.all}`
                : `${visibleSkills.length}`}
            </span>
          </div>

          {/* Grid */}
          {visibleSkills.length === 0 ? (
            <div className="agw-skill-empty">
              <AgentIcon name="book" size={22} />
              <p>
                {normalizedQuery
                  ? `No skills match "${searchQuery.trim()}".`
                  : sourceFilter === "project"
                    ? normalizedRoot
                      ? `No project skills in ${WORKSPACE_SKILL_FOLDERS.join(" or ")}.`
                      : "Open a workspace to load project skills."
                    : sourceFilter === "global"
                      ? "No global skills found."
                      : "No skills found."}
              </p>
            </div>
          ) : (
            <div className="agw-skill-grid agw-scroll">
              {visibleSkills.map((skill) => {
                const enabled = isSkillEnabled(skill, workspaceToggles, true);
                return (
                  <SkillCard
                    key={skill.storageKey}
                    skill={skill}
                    enabled={enabled}
                    disabled={!skillsEnabled || (capReached && !enabled)}
                    onToggle={handleToggle}
                  />
                );
              })}
            </div>
          )}

          {/* Source footnote */}
          <div className="agw-skill-foot">
            <span className="agw-skill-foot-row">
              <AgentIcon name="folder" size={11} />
              {normalizedRoot
                ? projectFolderHints
                    .map((f) => `${normalizedRoot}/${f}`)
                    .join("  ·  ")
                : "No workspace open"}
            </span>
            <span className="agw-skill-foot-row">
              <AgentIcon name="browser" size={11} />
              {globalSkillsPath ?? "Global skills path unavailable"}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
};
