import type { Message, TimelineEvent } from "../types";

export interface ContextToolCallPayload {
  id: string;
  name: string;
  arguments: string;
}

export interface ContextToolResultPayload {
  toolCallId: string;
  content: string;
  isError: boolean;
  truncated: boolean;
  originalLength: number | null;
}

export interface ContextToolCallRoundPayload {
  id: string;
  turnId: string;
  response: string;
  toolCalls: ContextToolCallPayload[];
  toolResults: Record<string, ContextToolResultPayload>;
  thinking: string | null;
  summary: string | null;
  tokenCount: number | null;
  roundIndex: number;
  createdAt: string;
}

export interface ContextTurnPayload {
  id: string;
  threadId: string;
  userMessage: string;
  userContext: string | null;
  rounds: ContextToolCallRoundPayload[];
  summary: string | null;
  tokenCount: number | null;
  turnIndex: number;
  createdAt: string;
  updatedAt: string;
}

const toIsoTimestamp = (value: number | string | undefined): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return new Date(numeric).toISOString();
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return new Date(0).toISOString();
};

const isTerminalToolEvent = (event: TimelineEvent): boolean => {
  const status = event.tool?.status;
  return (
    status === "complete" || status === "failed" || status === "rejected"
  );
};

const getToolArguments = (event: TimelineEvent): string => {
  const tool = event.tool;
  if (!tool) {
    return "{}";
  }

  if (tool.rawArgs && tool.rawArgs.trim() !== "") {
    return tool.rawArgs;
  }

  return JSON.stringify(tool.args ?? {});
};

const getToolResult = (event: TimelineEvent): ContextToolResultPayload | null => {
  const tool = event.tool;
  if (!tool) {
    return null;
  }

  if (tool.status === "complete") {
    return {
      toolCallId: tool.id,
      content: tool.result ?? "",
      isError: false,
      truncated: false,
      originalLength: null,
    };
  }

  if (tool.status === "failed") {
    return {
      toolCallId: tool.id,
      content: tool.error ?? tool.result ?? "Tool execution failed",
      isError: true,
      truncated: false,
      originalLength: null,
    };
  }

  if (tool.status === "rejected") {
    return {
      toolCallId: tool.id,
      content: tool.error ?? "Tool execution rejected by user",
      isError: true,
      truncated: false,
      originalLength: null,
    };
  }

  return null;
};

const buildRoundFromAssistantMessage = (
  turnId: string,
  message: Message,
  roundIndex: number,
): ContextToolCallRoundPayload | null => {
  const responseParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls = new Map<string, ContextToolCallPayload>();
  const toolResults = new Map<string, ContextToolResultPayload>();

  for (const event of message.timeline ?? []) {
    if (event.type === "content" && event.content) {
      responseParts.push(event.content);
      continue;
    }

    if (event.type === "thinking" && event.thinking) {
      thinkingParts.push(event.thinking);
      continue;
    }

    if (event.type !== "tool" || !event.tool || !isTerminalToolEvent(event)) {
      continue;
    }

    toolCalls.set(event.tool.id, {
      id: event.tool.id,
      name: event.tool.name,
      arguments: getToolArguments(event),
    });

    const result = getToolResult(event);
    if (result) {
      toolResults.set(event.tool.id, result);
    }
  }

  const response = responseParts.join("") || message.content || "";
  const thinking = thinkingParts.join("") || message.thinking || null;

  if (!response && !thinking && toolCalls.size === 0) {
    return null;
  }

  return {
    id: `${message.id}-round-${roundIndex}`,
    turnId,
    response,
    toolCalls: [...toolCalls.values()],
    toolResults: Object.fromEntries(
      [...toolResults.entries()].map(([id, result]) => [id, result]),
    ),
    thinking,
    summary: null,
    tokenCount: null,
    roundIndex,
    createdAt: toIsoTimestamp(message.timestamp),
  };
};

export const buildContextTurnsFromMessages = (
  threadId: string,
  messages: Message[],
): ContextTurnPayload[] => {
  const turns: ContextTurnPayload[] = [];
  let currentTurn: ContextTurnPayload | null = null;

  for (const message of messages) {
    if (message.sender === "user") {
      if (currentTurn) {
        turns.push(currentTurn);
      }

      const timestamp = toIsoTimestamp(message.timestamp);
      currentTurn = {
        id: message.id,
        threadId,
        userMessage: message.content,
        userContext: null,
        rounds: [],
        summary: null,
        tokenCount: null,
        turnIndex: turns.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      continue;
    }

    if (message.sender !== "assistant" || !currentTurn) {
      continue;
    }

    const round = buildRoundFromAssistantMessage(
      currentTurn.id,
      message,
      currentTurn.rounds.length,
    );

    if (!round) {
      continue;
    }

    currentTurn.rounds.push(round);
    currentTurn.updatedAt = round.createdAt;
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
};
