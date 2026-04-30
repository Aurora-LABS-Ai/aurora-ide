import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Check, FolderOpen, RefreshCw } from 'lucide-react';

import { IdeSwitch } from '../ui/IdeSwitch';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  getResolvedGlobalSkillsPath,
  isSkillEnabled,
  loadGlobalSkills,
  loadWorkspaceSkills,
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
  disabled: boolean;
  onToggle: (skill: SkillDefinition, enabled: boolean) => void;
  skill: SkillDefinition;
  skillToggles: Record<string, boolean>;
  isLast: boolean;
}

const SkillRow: React.FC<SkillRowProps> = ({
  disabled,
  onToggle,
  skill,
  skillToggles,
  isLast,
}) => {
  const enabled = isSkillEnabled(skill, skillToggles, true);
  const scope = skill.source === 'workspace' ? 'project' : 'global';
  const { Icon } = getScopeMeta(scope);

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
          disabled={disabled}
          size="sm"
          variant="primary"
        />
      </div>
    </div>
  );
};

interface SkillListProps {
  emptyMessage: string;
  skills: SkillDefinition[];
  disabled: boolean;
  onToggle: (skill: SkillDefinition, enabled: boolean) => void;
  skillToggles: Record<string, boolean>;
}

const SkillList: React.FC<SkillListProps> = ({
  emptyMessage,
  skills,
  disabled,
  onToggle,
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
          skill={skill}
          disabled={disabled}
          onToggle={onToggle}
          skillToggles={skillToggles}
          isLast={index === skills.length - 1}
        />
      ))}
    </div>
  );
};

export const SkillsSettingsTab: React.FC = () => {
  const { rootPath } = useWorkspaceStore();
  const { skillToggles, skillsEnabled, setSkillEnabled, setSkillsEnabled } = useSettingsStore();

  const [activeScope, setActiveScope] = useState<SkillsScope>('project');
  const [projectSkills, setProjectSkills] = useState<SkillDefinition[]>([]);
  const [globalSkills, setGlobalSkills] = useState<SkillDefinition[]>([]);
  const [globalSkillsPath, setGlobalSkillsPath] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  const handleToggle = (skill: SkillDefinition, enabled: boolean) => {
    setSkillEnabled(skill.storageKey, enabled);
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
  const enabledCount = activeSkills.filter((s) => isSkillEnabled(s, skillToggles, true)).length;

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Master switch                                                 */}
      {/* ============================================================ */}
      <Section
        title="Skills System"
        description="Enabled skills are the only external skill instructions Aurora injects into agent requests."
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
      </Section>

      {/* ============================================================ */}
      {/* Skill scope tabs                                              */}
      {/* ============================================================ */}
      <Section
        title="Available Skills"
        description="Skills loaded from the project's .aurora/skills folder and the global Aurora skills folder."
        badge={
          <StatusPill variant="info" dot={false}>
            {enabledCount} / {activeSkills.length} on
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
            {activeScope === 'project' ? 'Project skill root' : 'Global skill root'}
          </p>
          <p
            className="mt-1 break-all font-mono text-[11px] leading-snug text-text-secondary"
            title={
              activeScope === 'project'
                ? rootPath
                  ? `${rootPath.replace(/\\/g, '/')}/.aurora/skills`
                  : ''
                : globalSkillsPath ?? ''
            }
          >
            {activeScope === 'project'
              ? rootPath
                ? `${rootPath.replace(/\\/g, '/')}/.aurora/skills`
                : 'Open a workspace to load project skills.'
              : (globalSkillsPath ?? 'Global skills path is unavailable in this runtime.')}
          </p>
        </div>

        {/* Skill list */}
        <SkillList
          emptyMessage={
            activeScope === 'project'
              ? rootPath
                ? 'No project skills found in .aurora/skills.'
                : 'Open a workspace to inspect project skills.'
              : 'No global skills found in the global skills directory.'
          }
          skills={activeSkills}
          disabled={!skillsEnabled}
          onToggle={handleToggle}
          skillToggles={skillToggles}
        />
      </Section>
    </div>
  );
};
