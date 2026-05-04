import React, { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Check, FolderOpen, RefreshCw, Search, X } from 'lucide-react';

import { IdeSwitch } from '../ui/IdeSwitch';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  getResolvedGlobalSkillsPath,
  isSkillEnabled,
  loadGlobalSkills,
  loadWorkspaceSkills,
  MAX_ENABLED_SKILLS,
  WORKSPACE_SKILL_FOLDERS,
  type SkillDefinition,
} from '../../services/skills';
import {
  Section,
  FormRow,
  FormBlock,
  StatusPill,
  ActionButton,
} from './settings-primitives';
import { settingsRowDividerColor } from './settings-shared';

type SkillsScope = 'project' | 'global';

const getScopeMeta = (scope: SkillsScope) =>
  scope === 'project'
    ? {
        author: 'Workspace',
        badge: 'project',
        Icon: FolderOpen,
      }
    : {
        author: 'Global',
        badge: 'global',
        Icon: BookOpen,
      };

interface SkillRowProps {
  capReached: boolean;
  disabled: boolean;
  isLast: boolean;
  onToggle: (skill: SkillDefinition, enabled: boolean) => void;
  skill: SkillDefinition;
  skillToggles: Record<string, boolean>;
}

const SkillRow: React.FC<SkillRowProps> = ({
  capReached,
  disabled,
  isLast,
  onToggle,
  skill,
  skillToggles,
}) => {
  const enabled = isSkillEnabled(skill, skillToggles, true);
  const scope = skill.source === 'workspace' ? 'project' : 'global';
  const { Icon } = getScopeMeta(scope);
  // Disable the toggle when the master switch is off, or when the cap has
  // been reached *and* this row is currently off (so users can still flip
  // enabled rows off to free up a slot).
  const toggleDisabled = disabled || (capReached && !enabled);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={
        !isLast
          ? { borderBottom: `1px solid ${settingsRowDividerColor}` }
          : undefined
      }
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
          color: 'var(--aurora-common-primary)',
          borderRadius: 4,
        }}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[12.5px] font-medium leading-snug text-text-primary">
            {skill.name}
          </p>
          {enabled && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-success">
              <Check className="h-2.5 w-2.5" />
              On
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-text-secondary">
          {skill.description}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center px-1.5 py-0.5 font-mono text-[10px] text-text-disabled"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-editor-foreground) 5%, transparent)',
              border:
                '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
              borderRadius: 3,
            }}
          >
            {skill.id}
          </span>
          {skill.triggers.length > 0 && (
            <span className="text-[10px] text-text-disabled">
              {skill.triggers.length} trigger{skill.triggers.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      <div className="shrink-0">
        <IdeSwitch
          checked={enabled}
          onChange={(checked) => onToggle(skill, checked)}
          ariaLabel={`Toggle ${skill.name}`}
          disabled={toggleDisabled}
          size="sm"
          variant="primary"
        />
      </div>
    </div>
  );
};

interface SkillListProps {
  capReached: boolean;
  disabled: boolean;
  emptyMessage: string;
  onToggle: (skill: SkillDefinition, enabled: boolean) => void;
  skills: SkillDefinition[];
  skillToggles: Record<string, boolean>;
}

const SkillList: React.FC<SkillListProps> = ({
  capReached,
  disabled,
  emptyMessage,
  onToggle,
  skills,
  skillToggles,
}) => {
  if (skills.length === 0) {
    return (
      <FormBlock divided={false}>
        <p className="text-center text-[11.5px] text-text-secondary">{emptyMessage}</p>
      </FormBlock>
    );
  }

  return (
    <div>
      {skills.map((skill, index) => (
        <SkillRow
          key={skill.storageKey}
          capReached={capReached}
          disabled={disabled}
          isLast={index === skills.length - 1}
          onToggle={onToggle}
          skill={skill}
          skillToggles={skillToggles}
        />
      ))}
    </div>
  );
};

const matchesQuery = (skill: SkillDefinition, query: string): boolean => {
  if (!query) return true;
  const haystack = [
    skill.id,
    skill.name,
    skill.description,
    ...skill.triggers,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
};

export const SkillsSettingsTab: React.FC = () => {
  const { rootPath } = useWorkspaceStore();
  const { skillToggles, skillsEnabled, setSkillEnabled, setSkillsEnabled } = useSettingsStore();

  const [activeScope, setActiveScope] = useState<SkillsScope>('project');
  const [projectSkills, setProjectSkills] = useState<SkillDefinition[]>([]);
  const [globalSkills, setGlobalSkills] = useState<SkillDefinition[]>([]);
  const [globalSkillsPath, setGlobalSkillsPath] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [capWarning, setCapWarning] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const [loadedProjectSkills, resolvedGlobalPath] = await Promise.all([
        loadWorkspaceSkills(rootPath),
        getResolvedGlobalSkillsPath(),
      ]);
      setProjectSkills(loadedProjectSkills);
      setGlobalSkillsPath(resolvedGlobalPath);
      const loadedGlobalSkills = await loadGlobalSkills(resolvedGlobalPath);
      setGlobalSkills(loadedGlobalSkills);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    let isActive = true;
    const loadSkills = async () => {
      setIsRefreshing(true);
      try {
        const [loadedProjectSkills, resolvedGlobalPath] = await Promise.all([
          loadWorkspaceSkills(rootPath),
          getResolvedGlobalSkillsPath(),
        ]);
        if (!isActive) return;
        setProjectSkills(loadedProjectSkills);
        setGlobalSkillsPath(resolvedGlobalPath);
        const loadedGlobalSkills = await loadGlobalSkills(resolvedGlobalPath);
        if (!isActive) return;
        setGlobalSkills(loadedGlobalSkills);
      } finally {
        if (isActive) setIsRefreshing(false);
      }
    };
    void loadSkills();
    return () => {
      isActive = false;
    };
  }, [rootPath]);

  const totalEnabledCount = useMemo(
    () => Object.values(skillToggles).filter(Boolean).length,
    [skillToggles]
  );
  const capReached = totalEnabledCount >= MAX_ENABLED_SKILLS;

  const handleToggle = (skill: SkillDefinition, enabled: boolean) => {
    const applied = setSkillEnabled(skill.storageKey, enabled);
    if (!applied && enabled) {
      setCapWarning(
        `You can enable up to ${MAX_ENABLED_SKILLS} skills. Disable one before enabling \`${skill.name}\`.`
      );
      return;
    }
    setCapWarning(null);
  };

  const scopeButtonStyle = (scope: SkillsScope): React.CSSProperties => ({
    backgroundColor:
      activeScope === scope
        ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
        : 'transparent',
    border:
      activeScope === scope
        ? '1px solid color-mix(in srgb, var(--aurora-common-primary) 32%, transparent)'
        : '1px solid transparent',
    color:
      activeScope === scope
        ? 'var(--aurora-common-primary)'
        : 'var(--aurora-text-secondary, var(--aurora-editor-foreground))',
    borderRadius: 4,
  });

  const activeSkills = activeScope === 'project' ? projectSkills : globalSkills;
  const enabledInScope = activeSkills.filter((s) => isSkillEnabled(s, skillToggles, true)).length;
  const projectFolderHints = WORKSPACE_SKILL_FOLDERS.map((folder) => folder.replace(/\\/g, '/'));

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleSkills = useMemo(
    () =>
      normalizedQuery
        ? activeSkills.filter((skill) => matchesQuery(skill, normalizedQuery))
        : activeSkills,
    [activeSkills, normalizedQuery]
  );

  // Reset the query when the user switches scope so they don't see stale
  // "no matches" panels after flipping between Project / Global.
  useEffect(() => {
    setSearchQuery('');
  }, [activeScope]);

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Master switch                                                 */}
      {/* ============================================================ */}
      <Section
        title="Skills System"
        description={`Skills are coding playbooks. Enable up to ${MAX_ENABLED_SKILLS} from the lists below — the agent can search and load the rest on demand.`}
        badge={
          skillsEnabled ? (
            <StatusPill variant="success">Enabled</StatusPill>
          ) : (
            <StatusPill variant="neutral">Disabled</StatusPill>
          )
        }
      >
        <FormRow
          label="Master switch"
          hint="Per-skill toggles stay visible when off, but Aurora will not inject any skill content."
        >
          <IdeSwitch
            checked={skillsEnabled}
            onChange={setSkillsEnabled}
            ariaLabel="Toggle skill system"
            variant="primary"
            size="sm"
          />
        </FormRow>
        <FormRow
          label={`Enabled skills (${totalEnabledCount} / ${MAX_ENABLED_SKILLS})`}
          hint={
            capReached
              ? 'You have reached the maximum number of enabled skills. Disable one before enabling another.'
              : 'Each enabled skill contributes its description and a 5-line preview to the agent context.'
          }
        >
          <StatusPill
            variant={capReached ? 'warning' : totalEnabledCount === 0 ? 'neutral' : 'info'}
            dot={false}
          >
            {totalEnabledCount} / {MAX_ENABLED_SKILLS}
          </StatusPill>
        </FormRow>
        {capWarning && (
          <div
            className="px-4 py-2.5 text-[11.5px] leading-snug"
            style={{
              borderTop: `1px solid ${settingsRowDividerColor}`,
              backgroundColor:
                'color-mix(in srgb, var(--aurora-common-warning, var(--aurora-common-primary)) 8%, transparent)',
              color: 'var(--aurora-common-warning, var(--aurora-common-primary))',
            }}
            role="status"
          >
            {capWarning}
          </div>
        )}
      </Section>

      {/* ============================================================ */}
      {/* Skill scope tabs                                              */}
      {/* ============================================================ */}
      <Section
        title="Available Skills"
        description="Skills loaded from the project's skill folders and the global Aurora skills folder. The agent can also discover any of these on demand via aurora_skill_search and aurora_skill_load."
        badge={
          <StatusPill variant="info" dot={false}>
            {enabledInScope} / {activeSkills.length} on
          </StatusPill>
        }
      >
        {/* Scope toggle + refresh */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
          style={{
            borderBottom: `1px solid ${settingsRowDividerColor}`,
            backgroundColor:
              'color-mix(in srgb, var(--aurora-sidebar-background) 40%, transparent)',
          }}
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveScope('project')}
              className="h-7 px-3 text-[11.5px] font-semibold transition-colors"
              style={scopeButtonStyle('project')}
            >
              Project
            </button>
            <button
              type="button"
              onClick={() => setActiveScope('global')}
              className="h-7 px-3 text-[11.5px] font-semibold transition-colors"
              style={scopeButtonStyle('global')}
            >
              Global
            </button>
          </div>
          <ActionButton
            variant="secondary"
            icon={
              <RefreshCw
                className={clsx('h-3 w-3', isRefreshing && 'animate-spin')}
              />
            }
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
          >
            Refresh
          </ActionButton>
        </div>

        {/* Skill folder hint */}
        <div
          className="px-4 py-2.5"
          style={{
            borderBottom: `1px solid ${settingsRowDividerColor}`,
          }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
            {activeScope === 'project' ? 'Project skill roots' : 'Global skill root'}
          </p>
          {activeScope === 'project' ? (
            <div className="mt-1 space-y-0.5">
              {rootPath ? (
                projectFolderHints.map((folder) => (
                  <p
                    key={folder}
                    className="break-all font-mono text-[11px] leading-snug text-text-secondary"
                    title={`${rootPath.replace(/\\/g, '/')}/${folder}`}
                  >
                    {`${rootPath.replace(/\\/g, '/')}/${folder}`}
                  </p>
                ))
              ) : (
                <p className="font-mono text-[11px] leading-snug text-text-secondary">
                  Open a workspace to load project skills.
                </p>
              )}
            </div>
          ) : (
            <p
              className="mt-1 break-all font-mono text-[11px] leading-snug text-text-secondary"
              title={globalSkillsPath ?? ''}
            >
              {globalSkillsPath ?? 'Global skills path is unavailable in this runtime.'}
            </p>
          )}
        </div>

        {/* Search bar */}
        <div
          className="flex items-center gap-2 px-4 py-2.5"
          style={{
            borderBottom: `1px solid ${settingsRowDividerColor}`,
            backgroundColor:
              'color-mix(in srgb, var(--aurora-sidebar-background) 25%, transparent)',
          }}
        >
          <Search
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: 'var(--aurora-text-disabled, var(--aurora-editor-foreground))' }}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={
              activeScope === 'project'
                ? 'Search project skills by name, id, or trigger…'
                : 'Search global skills by name, id, or trigger…'
            }
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[12px] leading-snug outline-none placeholder:text-text-disabled"
            style={{
              color: 'var(--aurora-editor-foreground)',
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="flex h-5 w-5 shrink-0 items-center justify-center transition-colors"
              style={{
                color: 'var(--aurora-text-disabled, var(--aurora-editor-foreground))',
                borderRadius: 3,
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <span className="shrink-0 text-[10.5px] font-mono text-text-disabled tabular-nums">
            {normalizedQuery
              ? `${visibleSkills.length} / ${activeSkills.length}`
              : `${activeSkills.length}`}
          </span>
        </div>

        {/* Skill list — scrolls inline so the parent tab doesn't need to scroll */}
        <div
          className="overflow-y-auto scrollbar-thin"
          style={{
            // Bounded height keeps the list compact when sparse and scrollable
            // when full (e.g. ~300 global skills). 60vh adapts to viewport with
            // a hard floor/ceiling so the panel never collapses or runs away.
            maxHeight: 'clamp(280px, 58vh, 640px)',
          }}
        >
          <SkillList
            capReached={capReached}
            disabled={!skillsEnabled}
            emptyMessage={
              normalizedQuery
                ? `No skills match "${searchQuery.trim()}".`
                : activeScope === 'project'
                  ? rootPath
                    ? `No project skills found in ${WORKSPACE_SKILL_FOLDERS.join(' or ')}.`
                    : 'Open a workspace to inspect project skills.'
                  : 'No global skills found in the global skills directory.'
            }
            onToggle={handleToggle}
            skills={visibleSkills}
            skillToggles={skillToggles}
          />
        </div>
      </Section>
    </div>
  );
};
