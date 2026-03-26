import React from 'react';
import { BookOpen, Bot, GitBranch, HeartHandshake, Package2, Sparkles, Wrench } from 'lucide-react';
import { settingsCardStyle } from './settings-shared';

const APP_VERSION = '0.1.2';

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
  'Customization has to stay first-class, from providers and themes to workspace-specific skills.',
  'The interface should stay fast, local-feeling, and maintainable as capabilities expand.',
] as const;

export const AboutSettingsTab: React.FC = () => {
  return (
    <div className="space-y-4">
      <div
        className="relative overflow-hidden rounded-[24px] p-6"
        style={{
          ...settingsCardStyle,
          backgroundImage: `
            radial-gradient(circle at top right, color-mix(in srgb, var(--aurora-common-primary) 16%, transparent), transparent 42%),
            linear-gradient(180deg, color-mix(in srgb, var(--aurora-title-bar-background) 60%, transparent), color-mix(in srgb, var(--aurora-sidebar-background) 78%, transparent))
          `,
        }}
      >
        <div className="relative z-10 max-w-[620px]">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Aurora
          </div>
          <h1 className="mt-4 text-[34px] font-semibold leading-none text-text-primary">Built for the agentic editor era.</h1>
          <p className="mt-3 max-w-[560px] text-sm leading-relaxed text-text-secondary">
            Aurora combines editor workflow, local tooling, model orchestration, and project context into a single desktop environment that feels like an IDE first, not a chatbot wrapper.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
              <Package2 className="h-3.5 w-3.5" />
              Version {APP_VERSION}
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-xs font-semibold text-success">
              <BookOpen className="h-3.5 w-3.5" />
              Open architecture
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] gap-4">
        <div className="space-y-4">
          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <HeartHandshake className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Why Aurora exists</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  The goal is a code editor where AI execution, context control, and local workflow feel native instead of stitched together from separate tools.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {principleItems.map((item) => (
                <div
                  key={item}
                  className="rounded-2xl px-3 py-3 text-[12px] leading-relaxed text-text-secondary"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--aurora-common-muted) 74%, var(--aurora-sidebar-background) 26%)',
                    border: '1px solid color-mix(in srgb, var(--aurora-common-border) 56%, transparent)',
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <GitBranch className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Core capabilities</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  The editor is organized around provider flexibility, tool execution, and project-grounded context.
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              {featureItems.map(({ description, icon: Icon, title }) => (
                <div
                  key={title}
                  className="flex items-start gap-3 rounded-2xl px-3 py-3"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 74%, var(--aurora-sidebar-background) 26%)',
                    border: '1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)',
                  }}
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-text-primary">{title}</h4>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Creator</p>
            <div className="mt-3 flex items-center gap-3">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-semibold text-primary-foreground"
                style={{
                  backgroundImage: 'linear-gradient(135deg, var(--aurora-common-primary), color-mix(in srgb, var(--aurora-common-primary) 65%, white))',
                }}
              >
                A
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-primary">Alvan</h3>
                <p className="mt-1 text-[11px] text-text-secondary">Creator and ongoing builder of Aurora.</p>
              </div>
            </div>
            <p className="mt-4 text-[12px] leading-relaxed text-text-secondary">
              Aurora is being shaped around real workflow pressure: better agents, cleaner local control, stronger customization, and a UI that feels alive instead of generic.
            </p>
          </div>

          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Build Profile</p>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Release</span>
                <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {APP_VERSION}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Shell</span>
                <span className="text-xs font-medium text-text-primary">Tauri + React</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Focus</span>
                <span className="text-xs font-medium text-text-primary">Agentic coding workflow</span>
              </div>
            </div>
          </div>

          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Direction</p>
            <p className="mt-3 text-[12px] leading-relaxed text-text-secondary">
              The next visual step is consistency: the same depth and material system applied across settings, selectors, cards, and chat surfaces so the app stops feeling flat and starts feeling authored.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
