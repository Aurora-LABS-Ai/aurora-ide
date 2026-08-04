import { auroraInvoke } from "../lib/runtime";

export interface ProjectConversation {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  turns: number;
  /** Summed turn durations — time the agent was actually working. */
  activeMs: number;
  /** First to last message, including time the conversation sat idle. */
  spanMs: number;
  tokens: number;
  model: string | null;
  archived: boolean;
}

export interface ProjectLongTurn {
  threadId: string;
  threadTitle: string;
  prompt: string;
  startedAt: number;
  durationMs: number;
}

export interface ProjectModelUsage {
  name: string;
  threads: number;
  tokens: number;
}

export interface ProjectToolUsage {
  name: string;
  count: number;
}

export interface ProjectDayUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
}

export interface ProjectStats {
  workspaceRoot: string;
  totalConversations: number;
  archivedConversations: number;
  totalMessages: number;
  totalTurns: number;
  totalActiveMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  conversations: ProjectConversation[];
  topModels: ProjectModelUsage[];
  topTools: ProjectToolUsage[];
  longestTurns: ProjectLongTurn[];
  days: ProjectDayUsage[];
  firstActivity: string | null;
  lastActivity: string | null;
}

export const getProjectStats = (workspaceRoot: string): Promise<ProjectStats> =>
  auroraInvoke<ProjectStats>("project_stats_get", { workspaceRoot });

/**
 * Duration for the project panel: coarser than a single turn's readout, since
 * totals here run to hours and a seconds figure would be noise.
 */
export const formatProjectDuration = (ms: number): string => {
  if (ms <= 0) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
};

/** Relative day label for a conversation row. */
export const formatWhen = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};
