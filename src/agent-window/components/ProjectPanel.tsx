/**
 * Project details — a right-dock tab for one workspace folder.
 *
 * Surface: app UI, expert audience, job = orient. It answers what the chat list
 * cannot: how much time went into this project, which model did the work, which
 * turns ran long, and which conversation any of it came from.
 *
 * Layout rules this panel exists to hold:
 *
 * - **Constrained measure.** The dock can be dragged very wide; a reading
 *   surface must not follow it. Content caps at a readable width, otherwise a
 *   title and its number end up separated by a metre of dead space.
 * - **Two-line rows.** A prompt and its context both want room. Stacking them
 *   beats clipping two strings side by side into `there is pyside6 app u see…`
 *   next to `Pyside6 ap…`.
 * - **Never truncate a short value.** Counts and relative dates (`1 chat`,
 *   `3d ago`) get their natural width; only genuinely long text clamps.
 * - **Numbers align.** Durations and token counts sit in fixed right-hand
 *   columns with tabular figures so the column can be read vertically.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  formatProjectDuration,
  formatWhen,
  getProjectStats,
  type ProjectStats,
} from "../../services/agent-project-stats";
import { useSettingsStore } from "../../store/useSettingsStore";
import { formatTokens, prettyModel } from "../lib/model-label";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { AgentIcon } from "../shared";

/**
 * Ranked usage row — the exact treatment the Profile page uses for models and
 * tools (`.agw-profile-tool*`), reused rather than reinvented so the two
 * surfaces read as one product.
 */
const UsageBar: React.FC<{
  name: string;
  value: string;
  ratio: number;
  title?: string;
}> = ({ name, value, ratio, title }) => (
  <div className="agw-profile-tool">
    <span className="agw-profile-tool-name" title={title ?? name}>
      {name}
    </span>
    <span className="agw-profile-tool-track">
      <span
        className="agw-profile-tool-fill"
        style={{ width: `${Math.max(2, Math.round(ratio * 100))}%` }}
      />
    </span>
    <span className="agw-profile-tool-count">{value}</span>
  </div>
);

const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
};

const Section: React.FC<{
  title: string;
  count?: number;
  children: React.ReactNode;
}> = ({ title, count, children }) => (
  <section className="agw-proj-section">
    <h3 className="agw-proj-h">
      {title}
      {count !== undefined && <span className="agw-proj-h-count">{count}</span>}
    </h3>
    {children}
  </section>
);

/**
 * Loading state. A skeleton rather than a spinner: this panel is content, and
 * showing its shape while it resolves reads as "arriving" instead of "stalled".
 */
const ProjectSkeleton: React.FC = () => (
  <div className="agw-proj" aria-busy="true" aria-label="Loading project details">
    <div className="agw-proj-inner">
      <div className="agw-proj-head">
        <div className="agw-proj-skel-line" style={{ width: "42%", height: 20 }} />
        <div className="agw-proj-skel-line" style={{ width: "62%", height: 11 }} />
      </div>
      <div className="agw-proj-stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="agw-proj-stat">
            <div className="agw-proj-skel-line" style={{ width: 52, height: 18 }} />
            <div className="agw-proj-skel-line" style={{ width: 68, height: 10 }} />
          </div>
        ))}
      </div>
      {[0, 1].map((section) => (
        <div key={section} className="agw-proj-section">
          <div className="agw-proj-skel-line" style={{ width: 96, height: 11 }} />
          <div className="agw-proj-list">
            {[0, 1, 2].map((row) => (
              <div key={row} className="agw-proj-skel-row">
                <div
                  className="agw-proj-skel-line"
                  style={{ width: `${72 - row * 12}%`, height: 13 }}
                />
                <div
                  className="agw-proj-skel-line"
                  style={{ width: `${40 - row * 6}%`, height: 10 }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const ProjectPanel: React.FC<{ root: string }> = ({ root }) => {
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const selectThread = useAgentChatStore((s) => s.selectThread);
  const models = useSettingsStore((s) => s.models);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await getProjectStats(root));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !stats) return <ProjectSkeleton />;

  if (error && !stats) {
    return (
      <div className="agw-canvas-empty" role="alert">
        <AgentIcon name="help" size={24} />
        <strong>Couldn’t read this project</strong>
        <span>{error}</span>
        <button type="button" className="agw-canvas-retry" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (!stats) return null;

  if (stats.totalConversations === 0) {
    return (
      <div className="agw-canvas-empty">
        <AgentIcon name="folder" size={24} />
        <strong>No conversations here yet</strong>
        <span>
          Start a chat in {basename(root)} and its history, timings, and model
          usage collect here.
        </span>
      </div>
    );
  }

  const totalTokens = stats.inputTokens + stats.outputTokens;
  // Bars are proportional to the leader, so an empty list can't divide by zero.
  const maxModelTokens = Math.max(1, ...stats.topModels.map((m) => m.tokens));
  const maxToolCount = Math.max(1, ...stats.topTools.map((t) => t.count));

  return (
    <div className="agw-proj agw-scroll">
      <section
        className="agw-proj-inner"
        aria-label={`Project details: ${basename(root)}`}
      >
        <header className="agw-proj-head">
          <h2 className="agw-proj-title">{basename(root)}</h2>
          <span className="agw-proj-path" title={root}>
            {root}
          </span>
        </header>

        <div className="agw-proj-stats">
          <div
            className="agw-proj-stat"
            title="Sum of every turn's duration — excludes time conversations sat idle."
          >
            <span className="agw-proj-stat-value">
              {formatProjectDuration(stats.totalActiveMs)}
            </span>
            <span className="agw-proj-stat-label">time worked</span>
          </div>
          <div className="agw-proj-stat">
            <span className="agw-proj-stat-value">{stats.totalConversations}</span>
            <span className="agw-proj-stat-label">
              {stats.totalConversations === 1 ? "conversation" : "conversations"}
              {stats.archivedConversations > 0 &&
                ` · ${stats.archivedConversations} archived`}
            </span>
          </div>
          <div className="agw-proj-stat">
            <span className="agw-proj-stat-value">{stats.totalTurns}</span>
            <span className="agw-proj-stat-label">turns</span>
          </div>
          <div
            className="agw-proj-stat"
            title={`${stats.inputTokens.toLocaleString()} in · ${stats.outputTokens.toLocaleString()} out · ${stats.cacheReadTokens.toLocaleString()} cached`}
          >
            <span className="agw-proj-stat-value">{formatTokens(totalTokens)}</span>
            <span className="agw-proj-stat-label">tokens</span>
          </div>
        </div>

        {stats.topModels.length > 0 && (
          <Section title="Most used models">
            <div className="agw-profile-tools">
              {stats.topModels.map((model) => (
                <UsageBar
                  key={model.name}
                  name={prettyModel(model.name, models)}
                  value={formatTokens(model.tokens)}
                  ratio={model.tokens / maxModelTokens}
                  title={`${model.name}
${model.threads} chat${
                    model.threads === 1 ? "" : "s"
                  } · ${model.tokens.toLocaleString()} tokens`}
                />
              ))}
            </div>
          </Section>
        )}

        {stats.longestTurns.length > 0 && (
          <Section title="Longest turns">
            <ul className="agw-proj-list">
              {stats.longestTurns.map((turn) => (
                <li key={`${turn.threadId}-${turn.startedAt}`}>
                  <button
                    type="button"
                    className="agw-proj-row agw-proj-row-open"
                    onClick={() => void selectThread(turn.threadId, root)}
                    title={`${turn.prompt}\n\nin ${turn.threadTitle}`}
                  >
                    <span className="agw-proj-row-body">
                      <span className="agw-proj-row-main agw-proj-row-clamp">
                        {turn.prompt || turn.threadTitle}
                      </span>
                      <span className="agw-proj-row-sub">
                        in {turn.threadTitle}
                      </span>
                    </span>
                    <span className="agw-proj-row-num">
                      {formatProjectDuration(turn.durationMs)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {stats.topTools.length > 0 && (
          <Section title="Tools used">
            <div className="agw-profile-tools">
              {stats.topTools.map((tool) => (
                <UsageBar
                  key={tool.name}
                  name={tool.name}
                  value={String(tool.count)}
                  ratio={tool.count / maxToolCount}
                  title={`${tool.name} · ${tool.count} call${
                    tool.count === 1 ? "" : "s"
                  }`}
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Conversations" count={stats.conversations.length}>
          <ul className="agw-proj-list">
            {stats.conversations.map((conversation) => {
              const model = conversation.model
                ? prettyModel(conversation.model, models)
                : null;
              return (
                <li key={conversation.threadId}>
                  <button
                    type="button"
                    className="agw-proj-row agw-proj-row-open"
                    data-archived={conversation.archived || undefined}
                    onClick={() => void selectThread(conversation.threadId, root)}
                    title={conversation.title}
                  >
                    <span className="agw-proj-row-body">
                      <span className="agw-proj-row-main">
                        {conversation.title}
                        {conversation.archived && (
                          <span className="agw-proj-tag">archived</span>
                        )}
                      </span>
                      <span className="agw-proj-row-sub">
                        {formatWhen(conversation.updatedAt)} · {conversation.turns}{" "}
                        turn{conversation.turns === 1 ? "" : "s"}
                        {model && ` · ${model}`}
                      </span>
                    </span>
                    <span className="agw-proj-row-num">
                      {formatProjectDuration(conversation.activeMs)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      </section>
    </div>
  );
};
