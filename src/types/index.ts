export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  content?: string;
  language?: string;
  path?: string;
}

export interface Tab {
  id: string;
  path: string;
  filename: string;
  content: string;
  isDirty: boolean;
  language: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status: 'pending' | 'executing' | 'complete' | 'failed' | 'rejected';
  rawArgs?: string;
  result?: string;
  error?: string;
}

// Timeline event types for sequential display
export type TimelineEventType = 'thinking' | 'tool' | 'content';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: number;
  // For thinking events
  thinking?: string;
  isThinking?: boolean;
  // For tool events
  tool?: ToolCall;
  // For content events
  content?: string;
}

export interface Message {
  id: string;
  sender: 'user' | 'assistant';
  content: string;
  timestamp: number;
  // Legacy fields (still used for simple cases)
  thinking?: string;
  isThinking?: boolean;
  tools?: ToolCall[];
  // New: Timeline for sequential events
  timeline?: TimelineEvent[];
  toolProposal?: ToolProposal;
}

export interface ToolProposal {
  id: string;
  toolName: string;
  description: string;
  parameters: Record<string, any>;
  riskLevel: 'low' | 'medium' | 'high';
  diff?: string;
  originalContent?: string;
  modifiedContent?: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openai' | 'custom' | 'mock';
  baseUrl: string;
  apiKey?: string;
  modelId: string;
}

export interface AppSettings {
  autoApproveTools: boolean;
  fontSize: number;
  theme: 'dark' | 'light';
}
