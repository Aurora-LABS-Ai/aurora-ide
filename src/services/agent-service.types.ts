import type { StreamCallbacks as ProviderStreamCallbacks, ToolCallRequest } from "./providers/types";

export interface AgentCallbacks extends ProviderStreamCallbacks {
  onIterationComplete?: (iteration: number) => void;
  onToolApprovalRequired?: (toolCall: ToolCallRequest) => Promise<boolean>;
  onToolExecutionComplete?: (toolCall: ToolCallRequest, result: string) => void;
  onToolExecutionError?: (toolCall: ToolCallRequest, error: string) => void;
  onToolExecutionStart?: (toolCall: ToolCallRequest) => void;
  onToolRejected?: (toolCall: ToolCallRequest, reason: string) => void;
}

export interface AgentConfig {
  autoApproveTools?: boolean;
  beforeToolExecution?: () => Promise<void>;
  getToolApproval?: (toolName: string) => "auto" | "always_ask" | "deny";
  maxTokens?: number;
  maxToolIterations?: number;
  providerConfig?: import("./providers").ProviderConfig;
  systemPrompt?: string;
  temperature?: number;
  thinkingEnabled?: boolean;
  threadId?: string;
}

export interface ExecutedToolCall {
  args: Record<string, unknown>;
  id: string;
  name: string;
  result: string;
  status: "approved" | "rejected" | "executed" | "failed";
}

export interface AgentResponse {
  content: string;
  iterations: number;
  thinking?: string;
  toolCalls?: ExecutedToolCall[];
}
