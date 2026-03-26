import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Check, FolderOpen, RefreshCw, Sparkles } from 'lucide-react';

import { TogglePill } from '../ui/TogglePill';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  getResolvedGlobalSkillsPath,
  isSkillEnabled,
  loadGlobalSkills,
  loadWorkspaceSkills,
  type SkillDefinition,
} from '../../services/skills';
import { settingsCardStyle, settingsPrimaryButtonStyle, settingsSubtlePanelStyle } from './settings-shared';

type SkillsScope = 'project' | 'global';

const getScopeMeta = (scope: SkillsScope) =>
  scope === 'project'
    ? {
        author: 'Workspace Skills',
        badge: 'project',
        Icon: FolderOpen,
      }
    : {
        author: 'Global Skills',
        badge: 'global',
        Icon: BookOpen,
      };

const SkillCard: React.FC<{
  disabled: boolean;
  onToggle: (skill: SkillDefinition, enabled: boolean) => void;
  skill: SkillDefinition;
  skillToggles: Record<string, boolean>;
}> = ({ disabled, onToggle, skill, skillToggles }) => {
  const enabled = isSkillEnabled(skill, skillToggles, true);
  const scope = skill.source === 'workspace' ? 'project' : 'global';
  const { author, badge, Icon } = getScopeMeta(scope);

  return (
    <div className="flex h-full flex-col justify-between rounded-[20px] p-4" style={settingsCardStyle}>
      <div>
        <div className="flex items-start justify-between mb-2 gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Icon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h4 className="text-xs font-medium text-text-primary truncate">{skill.name}</h4>
              <p className="text-[9px] text-text-secondary">by {author}</p>
            </div>
          </div>
          {enabled && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-success/10 text-success flex items-center gap-1 shrink-0">
              <Check className="w-2.5 h-2.5" />
              Enabled
            </span>
          )}
        </div>

        <p className="text-[10px] text-text-secondary leading-relaxed mb-3 min-h-8 line-clamp-2">
          {skill.description}
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="rounded-full border border-border bg-input px-1.5 py-0.5 font-mono text-[9px] text-text-secondary">
            {badge}
          </span>
            <span className="max-w-[140px] truncate rounded-full border border-border bg-input px-1.5 py-0.5 font-mono text-[9px] text-text-disabled">
            {skill.id}
          </span>
          {skill.triggers.length > 0 && (
            <span className="rounded-full border border-border bg-input px-1.5 py-0.5 text-[9px] text-text-disabled">
              {skill.triggers.length} trigger{skill.triggers.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {skill.sourcePath && (
          <p className="text-[9px] text-text-disabled leading-relaxed break-all line-clamp-2">
            {skill.sourcePath}
          </p>
        )}
      </div>

      <div
        className={clsx(
          'mt-3 flex items-center justify-between gap-2 rounded-[16px] border px-3 py-2 text-[10px] font-medium transition-colors',
          enabled
            ? 'border-success/20 bg-success/5 text-text-primary'
            : 'text-text-secondary',
          disabled && 'opacity-90'
        )}
        style={!enabled ? settingsSubtlePanelStyle : undefined}
      >
        <span>{enabled ? 'Enabled' : 'Disabled'}</span>
        <TogglePill
          checked={enabled}
          onChange={(checked) => onToggle(skill, checked)}
          ariaLabel={`Toggle ${skill.name}`}
          disabled={disabled}
          size="sm"
        />
      </div>
    </div>
  );
};

const SkillList: React.FC<{
  emptyMessage: string;
  skills: SkillDefinition[];
  disabled: boolean;
  onToggle: (skill: SkillDefinition, enabled: boolean) => void;
  skillToggles: Record<string, boolean>;
}> = ({ emptyMessage, skills, disabled, onToggle, skillToggles }) => {
  if (skills.length === 0) {
    return (
      <div className="rounded-[20px] border border-dashed border-border px-3 py-6 text-center text-xs text-text-secondary" style={settingsCardStyle}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {skills.map((skill) => (
        <SkillCard
          key={skill.storageKey}
          skill={skill}
          disabled={disabled}
          onToggle={onToggle}
          skillToggles={skillToggles}
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

        if (!isActive) {
          return;
        }

        setProjectSkills(loadedProjectSkills);
        setGlobalSkillsPath(resolvedGlobalPath);

        const loadedGlobalSkills = await loadGlobalSkills(resolvedGlobalPath);
        if (!isActive) {
          return;
        }

        setGlobalSkills(loadedGlobalSkills);
      } finally {
        if (isActive) {
          setIsRefreshing(false);
        }
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

  const scopeButtonClass = (scope: SkillsScope): string =>
    clsx(
      'rounded-xl px-3 py-2 text-xs transition-colors',
      activeScope === scope
        ? 'bg-primary/10 font-medium text-primary'
        : 'text-text-secondary hover:text-text-primary'
    );

  return (
    <div className="space-y-4">
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-text-primary">Skills</h3>
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              Enabled skills are the only external skill instructions Aurora injects into agent requests.
            </p>
          </div>
          <TogglePill
            checked={skillsEnabled}
            onChange={setSkillsEnabled}
            ariaLabel="Toggle skill system"
            size="md"
            className="shrink-0"
          />
        </div>
        {!skillsEnabled && (
          <div className="mt-4 rounded-[16px] px-3 py-3 text-[11px] text-text-secondary" style={settingsSubtlePanelStyle}>
            Per-skill toggles stay visible while the skill system is off. Re-enable the master switch above to make those toggles active again.
          </div>
        )}
      </div>

      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-2xl p-1" style={settingsSubtlePanelStyle}>
            <button type="button" onClick={() => setActiveScope('project')} className={scopeButtonClass('project')}>
              Project
            </button>
            <button type="button" onClick={() => setActiveScope('global')} className={scopeButtonClass('global')}>
              Global
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-primary-foreground transition-colors disabled:opacity-60"
            style={settingsPrimaryButtonStyle}
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>

        {activeScope === 'project' && (
          <div className="mt-4 space-y-3">
            <div className="rounded-[18px] p-3" style={settingsSubtlePanelStyle}>
              <div className="flex items-center gap-2">
                <FolderOpen className="h-3.5 w-3.5 text-text-secondary" />
                <p className="text-xs font-medium text-text-primary">Project skill root</p>
              </div>
              <p className="mt-2 break-all text-[11px] text-text-secondary">
                {rootPath ? `${rootPath.replace(/\\/g, '/')}/.aurora/skills` : 'Open a workspace to load project skills.'}
              </p>
            </div>

            <SkillList
              emptyMessage={rootPath ? 'No project skills found in .aurora/skills.' : 'Open a workspace to inspect project skills.'}
              skills={projectSkills}
              disabled={!skillsEnabled}
              onToggle={handleToggle}
              skillToggles={skillToggles}
            />
          </div>
        )}

        {activeScope === 'global' && (
          <div className="mt-4 space-y-3">
            <div className="rounded-[18px] p-3" style={settingsSubtlePanelStyle}>
              <div className="flex items-center gap-2">
                <BookOpen className="h-3.5 w-3.5 text-text-secondary" />
                <p className="text-xs font-medium text-text-primary">Global skill root</p>
              </div>
              <p className="mt-2 break-all text-[11px] text-text-secondary">
                {globalSkillsPath ?? 'Global skills path is unavailable in this runtime.'}
              </p>
            </div>

            <SkillList
              emptyMessage="No global skills found in the global skills directory."
              skills={globalSkills}
              disabled={!skillsEnabled}
              onToggle={handleToggle}
              skillToggles={skillToggles}
            />
          </div>
        )}
      </div>
    </div>
  );
};
