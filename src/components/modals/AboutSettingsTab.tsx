import React, { useEffect, useState } from 'react';
import { Bot, GitBranch, HeartHandshake, Sparkles, Wrench } from 'lucide-react';
import { getAppVersion, PACKAGE_VERSION } from '../../lib/app-version';
import {
  Section,
  FormBlock,
  KeyValue,
  StatusPill,
} from './settings-primitives';
import { settingsRowDividerColor } from './settings-shared';

const featureItems = [
  {
    description: 'Threaded context, tool execution, MCP integration, and agent mode in one desktop workspace.',
    icon: Bot,
    title: 'Agent-native editor',
  },
  {
    description: 'Theme tokens, semantic search, terminal control, and Git workflows built into the shell.',
    icon: Sparkles,
    title: 'Integrated craft',
  },
  {
    description: 'Skills, workspace rules, and extensible providers keep Aurora adaptable instead of locked down.',
    icon: Wrench,
    title: 'Extensible by design',
  },
] as const;

const principleItems = [
  'AI assistance should feel like part of the IDE, not a bolted-on side chat.',
  'Customization stays first-class — providers, themes, workspace skills.',
  'The interface should stay fast, local-feeling, and maintainable as capabilities expand.',
] as const;

export const AboutSettingsTab: React.FC = () => {
  const [appVersion, setAppVersion] = useState(PACKAGE_VERSION);

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Header                                                       */}
      {/* ============================================================ */}
      <Section
        title="Aurora"
        description="An agent-native code editor for the IDE-first AI workflow."
        badge={<StatusPill variant="info">v{appVersion}</StatusPill>}
      >
        <FormBlock divided={false}>
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center font-semibold"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, var(--aurora-common-primary), color-mix(in srgb, var(--aurora-common-primary) 65%, white))',
                color: 'var(--aurora-common-primary-foreground)',
                borderRadius: 6,
              }}
            >
              A
            </div>
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium leading-snug text-text-primary">
                Built for the agentic editor era.
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-secondary">
                Aurora combines editor workflow, local tooling, model orchestration, and project context into a single desktop environment that feels like an IDE first, not a chatbot wrapper.
              </p>
            </div>
          </div>
        </FormBlock>
      </Section>

      {/* ============================================================ */}
      {/* Build Profile                                                */}
      {/* ============================================================ */}
      <Section
        title="Build Profile"
        description="What's running under this session."
      >
        <div
          className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-4 py-3.5"
        >
          <KeyValue label="Release" value={appVersion} mono />
          <KeyValue label="Shell" value="Tauri + React" />
          <KeyValue label="Focus" value="Agentic coding workflow" />
          <KeyValue label="Schema" value="SQLite v11" mono />
        </div>
      </Section>

      {/* ============================================================ */}
      {/* Why Aurora exists                                            */}
      {/* ============================================================ */}
      <Section
        title="Why Aurora exists"
        description="A code editor where AI execution, context control, and local workflow feel native instead of stitched together from separate tools."
        badge={<HeartHandshake className="h-3.5 w-3.5 text-text-secondary" />}
      >
        {principleItems.map((item, index) => (
          <div
            key={item}
            className="px-4 py-3 text-[12px] leading-relaxed text-text-secondary"
            style={
              index < principleItems.length - 1
                ? { borderBottom: `1px solid ${settingsRowDividerColor}` }
                : undefined
            }
          >
            <span
              className="mr-2 inline-flex items-center justify-center text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled"
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            {item}
          </div>
        ))}
      </Section>

      {/* ============================================================ */}
      {/* Core capabilities                                            */}
      {/* ============================================================ */}
      <Section
        title="Core Capabilities"
        description="The editor is organized around provider flexibility, tool execution, and project-grounded context."
        badge={<GitBranch className="h-3.5 w-3.5 text-text-secondary" />}
      >
        {featureItems.map(({ description, icon: Icon, title }, index) => (
          <div
            key={title}
            className="flex items-start gap-3 px-4 py-3.5"
            style={
              index < featureItems.length - 1
                ? { borderBottom: `1px solid ${settingsRowDividerColor}` }
                : undefined
            }
          >
            <div
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
                color: 'var(--aurora-common-primary)',
                borderRadius: 4,
              }}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium leading-snug text-text-primary">
                {title}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-secondary">
                {description}
              </p>
            </div>
          </div>
        ))}
      </Section>

      {/* ============================================================ */}
      {/* Creator                                                      */}
      {/* ============================================================ */}
      <Section
        title="Creator"
        description="The person shaping Aurora's direction."
      >
        <FormBlock divided={false}>
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center font-semibold"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, var(--aurora-common-primary), color-mix(in srgb, var(--aurora-common-primary) 65%, white))',
                color: 'var(--aurora-common-primary-foreground)',
                borderRadius: 6,
              }}
            >
              A
            </div>
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium leading-snug text-text-primary">
                Alvan
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-secondary">
                Creator and ongoing builder of Aurora. Shaping the editor around real workflow pressure: better agents, cleaner local control, stronger customization, and a UI that feels alive instead of generic.
              </p>
            </div>
          </div>
        </FormBlock>
      </Section>
    </div>
  );
};
