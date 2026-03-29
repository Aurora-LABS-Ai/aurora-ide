export interface AppSettings {
  autoApproveTools: boolean;
  fontSize: number;
  theme: 'dark' | 'light';
}

export interface FileNode {
  children?: FileNode[];
  content?: string;
  id: string;
  language?: string;
  name: string;
  path?: string;
  type: 'file' | 'folder';
}

export interface Message {
  content: string;
  id: string;
  isThinking?: boolean;
  sender: 'user' | 'assistant';

  // Legacy fields (still used for simple cases)
  thinking?: string;

  // New: Timeline for sequential events
  timeline?: TimelineEvent[];
  timestamp: number;
  toolProposal?: ToolProposal;
  tools?: ToolCall[];

  // Attachments displayed on user message bubbles
  attachedFiles?: { path: string; name: string }[];
  attachedPromptAssets?: { key: string; type: string; title: string }[];
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl: string;
  id: string;
  modelId: string;
  name: string;
  type: 'openai' | 'custom' | 'mock';
}

export interface Tab {
  canGoBack?: boolean;
  canGoForward?: boolean;
  content: string;
  favicon?: string;
  filename: string;
  id: string;
  isDeleted?: boolean;
  isDirty: boolean;
  isLargeFile?: boolean;
  isMediumFile?: boolean;
  isLoading?: boolean;
  language: string;
  path: string;

  // Browser tab support
  type?: 'file' | 'browser';
  url?: string;
}


export interface TimelineEvent {
  // For content events
  content?: string;
  id: string;
  isThinking?: boolean;

  // For thinking events
  thinking?: string;
  timestamp: number;

  // For tool events
  tool?: ToolCall;
  type: TimelineEventType;
}

export interface ToolCall {
  args: Record<string, any>;
  error?: string;
  id: string;
  name: string;
  rawArgs?: string;
  result?: string;
  status: 'pending' | 'executing' | 'complete' | 'failed' | 'rejected';
}

export interface ToolProposal {
  description: string;
  diff?: string;
  id: string;
  modifiedContent?: string;
  originalContent?: string;
  parameters: Record<string, any>;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  toolName: string;
}

// Timeline event types for sequential display
export type TimelineEventType = 'thinking' | 'tool' | 'content';

// Re-export theme types
export * from './theme';
