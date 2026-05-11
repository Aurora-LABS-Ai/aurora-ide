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

  /**
   * Page elements the user picked from a native browser preview window
   * before sending. Stored on the message in compact pill form so the
   * bubble can show "Selected 1 / Selected 2" pills (with hover tooltips)
   * instead of a wall of XML. The full element payload — including
   * outerHTML — flows to the agent via the `ideContext` sidecar built
   * by `buildQueryContext`, not via this field.
   */
  attachedSelectedElements?: SelectedElementPill[];
}

export interface SelectedElementPill {
  index: number;
  selector: string;
  tagName: string;
  url: string | null;
  text: string | null;
  source: 'inspector' | 'stagewise';
  /** Optional user note from the Stagewise toolbar. */
  note: string | null;
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
  /**
   * Disk mtime captured when the tab last loaded its content. Used by the
   * editor for cache-free freshness checks: `stat_file_mtime` against this
   * value tells us whether the on-disk file has diverged since we read it,
   * without needing to keep a duplicate copy of the bytes anywhere.
   */
  mtime?: number;
  path: string;

  // Browser tab support
  type?: 'file' | 'browser';
  url?: string;
  /**
   * For browser tabs: when set, this tab is *adopting* an existing
   * native WebView window the agent (or a previous IDE session)
   * already opened, rather than creating a new one. The label points
   * into `BrowserManager`'s registry on the Rust side. Closing the
   * tab will detach instead of destroying the window.
   */
  adoptedBrowserLabel?: string;
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
