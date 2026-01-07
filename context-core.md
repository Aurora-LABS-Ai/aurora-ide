# Context & Conversation Architecture: Aurora vs Copilot

> **Purpose**: Deep dive into how Aurora and VS Code Copilot handle conversation context, message history, and API calls.

---

## Quick Reference

| Aspect | Aurora | Copilot |
|--------|--------|---------|
| **Core Structure** | Flat `Message[]` | `Turn[]` with nested rounds |
| **Context Management** | Full history every request | Summarization system |
| **Tool Calls** | Inline messages | Grouped in `IToolCallRound` |
| **File References** | Manual `#file:path` | Rich `PromptReference` system |
| **Variables** | Not supported | `@workspace`, `@file`, `#selection` |
| **Token Management** | Manual limits | Automatic prioritization |

---

## Architecture Comparison

### Aurora Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AgentService                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ conversationHistory: Message[]                          ││
│  │ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        ││
│  │ │ system  │ │ user    │ │assistant│ │  tool   │  ...   ││
│  │ └─────────┘ └─────────┘ └─────────┘ └─────────┘        ││
│  └─────────────────────────────────────────────────────────┘│
│                           ↓                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ API Request: { messages: [...all history...] }          ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**Key Files:**
- [`agent-service.ts`](src/services/agent-service.ts) - Main orchestration
- [`providers/types.ts`](src/services/providers/types.ts) - Message types

---

### Copilot Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Conversation                            │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ turns: Turn[]                                           ││
│  │ ┌───────────────────────────────────────────────────┐   ││
│  │ │ Turn 1                                            │   ││
│  │ │ ├─ request: TurnMessage                           │   ││
│  │ │ ├─ references: PromptReference[]                  │   ││
│  │ │ ├─ promptVariables: ChatVariablesCollection       │   ││
│  │ │ └─ rounds: IToolCallRound[]                       │   ││
│  │ │     ├─ Round 1: { response, toolCalls, summary }  │   ││
│  │ │     └─ Round 2: { response, toolCalls, summary }  │   ││
│  │ └───────────────────────────────────────────────────┘   ││
│  │ ┌───────────────────────────────────────────────────┐   ││
│  │ │ Turn 2 (with summarized Turn 1)                   │   ││
│  │ └───────────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**Key Files (Copilot):**
- `vscode-copilot-chat-main/src/extension/prompt/common/conversation.ts` - Turn & Conversation classes
- `vscode-copilot-chat-main/src/extension/prompts/node/panel/conversationHistory.tsx` - History rendering
- `vscode-copilot-chat-main/src/extension/prompt/common/toolCallRound.ts` - Tool call grouping
- `vscode-copilot-chat-main/src/extension/prompt/common/chatVariablesCollection.ts` - Variable handling

---

## Detailed Code Comparison

### Message Structure

#### Aurora (`Message`)

```typescript
// From: src/services/providers/types.ts
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_call_id?: string;       // For tool responses
  tool_calls?: ToolCallRequest[];  // For assistant tool requests
  reasoning_content?: string;  // For thinking/reasoning
}
```

#### Copilot (`Turn` + `TurnMessage`)

```typescript
// From: vscode-copilot-chat-main/src/extension/prompt/common/conversation.ts (lines 33-37, 58-189)
type TurnMessage = {
  readonly type: 'user' | 'follow-up' | 'template' | 'model' | 'meta' | 'server';
  readonly name?: string;
  message: string;
};

class Turn {
  id: string;                                    // Unique turn identifier
  request: TurnMessage;                          // User's request
  promptVariables: ChatVariablesCollection;      // @workspace, @file, etc.
  toolReferences: InternalToolReference[];       // Explicitly referenced tools
  references: PromptReference[];                 // File/symbol references
  editedFileEvents: ChatRequestEditedFileEvent[]; // Files edited during turn
  
  // Response tracking
  responseMessage?: TurnMessage;
  responseStatus: TurnStatus;  // 'in-progress' | 'success' | 'cancelled' | 'error'
  responseChatResult?: ChatResult;
  
  // Tool calls grouped by rounds
  rounds: IToolCallRound[];
  
  // Metadata for summarization
  resultMetadata: IResultMetadata;
}
```

---

### How Conversation History is Built

#### Aurora: Simple Append

```typescript
// From: src/services/agent-service.ts (lines 91-98)
const messages: Message[] = [
  { role: 'system', content: enhancedSystemPrompt },
  ...this.conversationHistory,
  { role: 'user', content: userMessage },
];

// Add user message to history
this.conversationHistory.push({ role: 'user', content: userMessage });

// After assistant response (line 152-153)
messages.push(response);
this.conversationHistory.push(response);

// After tool execution (line 329-330)
messages.push(result.message);
this.conversationHistory.push(result.message);
```

#### Copilot: Turn-Based with Summarization

```typescript
// From: vscode-copilot-chat-main/src/extension/prompt/common/conversation.ts (lines 191-218)
function normalizeSummariesOnRounds(turns: readonly Turn[]): void {
  for (const [idx, turn] of turns.entries()) {
    const turnSummary = turn.resultMetadata?.summary;
    if (turnSummary) {
      // Find the round this summary belongs to
      const roundInTurn = turn.rounds.find(
        round => round.id === turnSummary.toolCallRoundId
      );
      if (roundInTurn) {
        roundInTurn.summary = turnSummary.text;  // Attach summary to round
      }
    }
  }
}

// From: vscode-copilot-chat-main/src/extension/prompts/node/panel/conversationHistory.tsx
class ConversationHistory extends PromptElement {
  render() {
    // Older turns use summaries, recent turns use full content
    return this.props.history.map((turn, idx) => {
      const isRecent = idx >= this.props.history.length - 2;
      return isRecent 
        ? <FullTurnContent turn={turn} />
        : <SummarizedTurnContent turn={turn} />;
    });
  }
}
```

---

## Comprehensive Multi-Turn Example

### Scenario: User asks to refactor a function, then fix a bug, then add tests

---

### Aurora Approach (No Summarization)

```
═══════════════════════════════════════════════════════════════════════════════
MESSAGE 1: User asks to refactor
═══════════════════════════════════════════════════════════════════════════════

API Request:
┌──────────────────────────────────────────────────────────────────────────────┐
│ messages: [                                                                  │
│   { role: "system", content: "You are Aurora..." },                         │
│   { role: "user", content: "Refactor the processData function in utils.ts" }│
│ ]                                                                            │
└──────────────────────────────────────────────────────────────────────────────┘

API Response + Tool Execution:
┌──────────────────────────────────────────────────────────────────────────────┐
│ Assistant: "I'll read the file first..."                                     │
│ tool_calls: [{ name: "file_read", args: { path: "utils.ts" } }]             │
└──────────────────────────────────────────────────────────────────────────────┘

History After Message 1:
┌──────────────────────────────────────────────────────────────────────────────┐
│ conversationHistory = [                                                      │
│   { role: "user", content: "Refactor the processData..." },                 │
│   { role: "assistant", content: "I'll read...", tool_calls: [...] },        │
│   { role: "tool", tool_call_id: "1", content: "// file content..." },       │
│   { role: "assistant", content: "Here's the refactored version..." }        │
│ ]                                                                            │
│                                                                              │
│ Total tokens: ~2,500                                                         │
└──────────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════
MESSAGE 2: User reports a bug
═══════════════════════════════════════════════════════════════════════════════

API Request (FULL HISTORY SENT):
┌──────────────────────────────────────────────────────────────────────────────┐
│ messages: [                                                                  │
│   { role: "system", content: "You are Aurora..." },                         │
│   { role: "user", content: "Refactor the processData..." },      // OLD     │
│   { role: "assistant", content: "I'll read...", tool_calls },    // OLD     │
│   { role: "tool", content: "// file content..." },               // OLD     │
│   { role: "assistant", content: "Here's the refactored..." },    // OLD     │
│   { role: "user", content: "There's a bug - it crashes on null" } // NEW    │
│ ]                                                                            │
│                                                                              │
│ Total tokens sent: ~2,800 (growing with each message!)                       │
└──────────────────────────────────────────────────────────────────────────────┘

History After Message 2:
┌──────────────────────────────────────────────────────────────────────────────┐
│ conversationHistory = [                                                      │
│   { role: "user", content: "Refactor the processData..." },                 │
│   { role: "assistant", ... },                                                │
│   { role: "tool", ... },                                                     │
│   { role: "assistant", content: "Here's the refactored..." },               │
│   { role: "user", content: "There's a bug..." },                            │
│   { role: "assistant", content: "Fixed! Added null check...", tool_calls }, │
│   { role: "tool", content: "{ success: true }" },                           │
│   { role: "assistant", content: "Done, the fix is applied." }               │
│ ]                                                                            │
│                                                                              │
│ Total tokens: ~4,200                                                         │
└──────────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════
MESSAGE 3: User asks for tests
═══════════════════════════════════════════════════════════════════════════════

API Request (FULL HISTORY - EVEN LARGER):
┌──────────────────────────────────────────────────────────────────────────────┐
│ messages: [                                                                  │
│   { role: "system", content: "You are Aurora..." },                         │
│   // ALL 8 previous messages included verbatim                               │
│   { role: "user", content: "Now add unit tests for processData" }           │
│ ]                                                                            │
│                                                                              │
│ Total tokens sent: ~4,500+ (FULL HISTORY, NO COMPRESSION)                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

> [!WARNING]
> **Aurora Problem**: Token usage grows unbounded. After 10+ messages with file reads, you can easily hit 100K+ tokens.

---

### Copilot Approach (Turn-Based with Summarization)

```
═══════════════════════════════════════════════════════════════════════════════
TURN 1: User asks to refactor
═══════════════════════════════════════════════════════════════════════════════

Turn Object Created:
┌──────────────────────────────────────────────────────────────────────────────┐
│ Turn {                                                                       │
│   id: "turn-001",                                                           │
│   request: { type: "user", message: "Refactor processData in utils.ts" },   │
│   references: [                                                              │
│     PromptReference { anchor: { uri: "utils.ts" } }  // Auto-detected       │
│   ],                                                                         │
│   promptVariables: ChatVariablesCollection {},                              │
│   rounds: [                                                                  │
│     {                                                                        │
│       id: "round-001-1",                                                    │
│       response: "I'll read the file first...",                              │
│       toolCalls: [{ name: "file_read", args: { path: "utils.ts" } }],       │
│       toolResults: { "call-1": "// file content..." },                      │
│       summary: null  // Not yet summarized                                  │
│     },                                                                       │
│     {                                                                        │
│       id: "round-001-2",                                                    │
│       response: "Here's the refactored version...",                         │
│       toolCalls: [{ name: "search_replace", ... }],                         │
│       toolResults: { "call-2": "{ success: true }" },                       │
│       summary: null                                                         │
│     }                                                                        │
│   ],                                                                         │
│   responseStatus: "success",                                                │
│   resultMetadata: {                                                         │
│     toolCallRounds: [...],                                                  │
│     renderedUserMessage: [...]                                              │
│   }                                                                          │
│ }                                                                            │
└──────────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════
TURN 2: User reports a bug (Turn 1 gets SUMMARIZED)
═══════════════════════════════════════════════════════════════════════════════

Summarization Happens:
┌──────────────────────────────────────────────────────────────────────────────┐
│ Turn 1 is summarized before building the prompt:                             │
│                                                                              │
│ Original Turn 1 rounds: ~2,500 tokens                                        │
│ Summarized Turn 1: ~200 tokens                                               │
│                                                                              │
│ Summary: "User asked to refactor processData() in utils.ts.                 │
│           I read the file and applied refactoring: extracted helper         │
│           functions, added type annotations, improved error handling."      │
└──────────────────────────────────────────────────────────────────────────────┘

API Request Built:
┌──────────────────────────────────────────────────────────────────────────────┐
│ ConversationHistory.render() produces:                                       │
│                                                                              │
│ <SystemMessage>You are GitHub Copilot...</SystemMessage>                    │
│                                                                              │
│ <!-- Turn 1: SUMMARIZED -->                                                 │
│ <UserMessage>Refactor processData in utils.ts</UserMessage>                 │
│ <AssistantMessage>                                                          │
│   [Summary] Refactored processData(): extracted helpers, added types.       │
│ </AssistantMessage>                                                         │
│                                                                              │
│ <!-- Turn 2: FULL -->                                                       │
│ <UserMessage>There's a bug - it crashes on null</UserMessage>               │
│                                                                              │
│ Total tokens: ~800 (vs Aurora's ~2,800!)                                     │
└──────────────────────────────────────────────────────────────────────────────┘

Turn 2 Object:
┌──────────────────────────────────────────────────────────────────────────────┐
│ Turn {                                                                       │
│   id: "turn-002",                                                           │
│   request: { type: "user", message: "There's a bug - crashes on null" },    │
│   rounds: [                                                                  │
│     {                                                                        │
│       id: "round-002-1",                                                    │
│       response: "I see the issue. Adding null check...",                    │
│       toolCalls: [{ name: "search_replace", ... }],                         │
│       summary: null                                                         │
│     }                                                                        │
│   ],                                                                         │
│   responseStatus: "success"                                                 │
│ }                                                                            │
└──────────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════
TURN 3: User asks for tests (Turn 1 & 2 SUMMARIZED)
═══════════════════════════════════════════════════════════════════════════════

API Request Built:
┌──────────────────────────────────────────────────────────────────────────────┐
│ <!-- Turn 1: SUMMARIZED -->                                                 │
│ <UserMessage>Refactor processData in utils.ts</UserMessage>                 │
│ <AssistantMessage>[Summary] Refactored with helpers and types</AssistantMessage>│
│                                                                              │
│ <!-- Turn 2: SUMMARIZED -->                                                 │
│ <UserMessage>There's a bug - crashes on null</UserMessage>                  │
│ <AssistantMessage>[Summary] Fixed null crash with guard clause</AssistantMessage>│
│                                                                              │
│ <!-- Turn 3: FULL -->                                                       │
│ <UserMessage>Now add unit tests for processData</UserMessage>               │
│                                                                              │
│ Total tokens: ~600 (vs Aurora's ~4,500!)                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

> [!TIP]
> **Copilot Advantage**: Token usage stays manageable. Even after 50 turns, it stays under a reasonable limit due to summarization.

---

## Token Usage Comparison Over Time

```
Tokens
  │
5K├─────────────────────────────────────────────●─────── Aurora
  │                                          ●
4K├──────────────────────────────────────●
  │                                   ●
3K├───────────────────────────────●
  │                            ●
2K├────────────────────────●
  │                     ●
1K├─────────●─────●─────●─────●─────●─────●─────●────── Copilot
  │      ●     (summaries keep it flat)
0 ├────●────┬────┬────┬────┬────┬────┬────┬────┬───▶ Messages
  │    1    2    3    4    5    6    7    8    9
```

---

## Key Data Structures

### Aurora Message Types

```typescript
// Simple flat structure
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
}

// Stored in: AgentService.conversationHistory
```

### Copilot Turn System

```typescript
// From: conversation.ts (line 23-31)
enum TurnStatus {
  InProgress = 'in-progress',
  Success = 'success',
  Cancelled = 'cancelled',
  OffTopic = 'off-topic',
  Filtered = 'filtered',
  PromptFiltered = 'prompt-filtered',
  Error = 'error',
}

// From: conversation.ts (line 345-366)
interface IResultMetadata {
  modelMessageId: string;
  responseId: string;
  sessionId: string;
  renderedUserMessage?: Raw.ChatCompletionContentPart[];
  codeBlocks?: readonly CodeBlock[];
  toolCallRounds?: readonly IToolCallRound[];
  toolCallResults?: Record<string, LanguageModelToolResult>;
  maxToolCallsExceeded?: boolean;
  summary?: { toolCallRoundId: string; text: string };
}

// From: Conversation class (line 224-243)
class Conversation {
  sessionId: string;
  turns: Turn[];
  
  getLatestTurn(): Turn {
    return this.turns.at(-1);  // Safe access to last turn
  }
}
```

---

## What Aurora Should Implement

### Priority 1: Turn-Based Structure

```typescript
// Proposed: src/services/context/turn.ts
interface Turn {
  id: string;
  request: { message: string; timestamp: number };
  references: FileReference[];
  rounds: ToolCallRound[];
  response?: string;
  status: 'pending' | 'success' | 'error' | 'cancelled';
  summary?: string;  // For older turns
}

interface ToolCallRound {
  id: string;
  toolCalls: ToolCallRequest[];
  toolResults: Map<string, string>;
  response: string;
}
```

### Priority 2: Summarization

```typescript
// Proposed: src/services/context/summarizer.ts
async function summarizeTurn(turn: Turn): Promise<string> {
  // Use the same model to summarize
  const summary = await provider.chat({
    messages: [
      { role: 'system', content: 'Summarize this conversation turn in 2-3 sentences...' },
      { role: 'user', content: formatTurnForSummary(turn) }
    ],
    maxTokens: 200
  });
  return summary;
}
```

### Priority 3: Smart History Building

```typescript
// Proposed: src/services/context/history-builder.ts
function buildMessagesForRequest(
  turns: Turn[],
  currentMessage: string,
  maxTokens: number = 100000
): Message[] {
  const messages: Message[] = [];
  let tokenCount = 0;
  
  // Always include system prompt
  messages.push({ role: 'system', content: systemPrompt });
  tokenCount += estimateTokens(systemPrompt);
  
  // Process turns from newest to oldest
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const isRecent = i >= turns.length - 2;
    
    if (isRecent) {
      // Include full turn content
      const turnMessages = formatFullTurn(turn);
      const turnTokens = estimateTokens(turnMessages);
      
      if (tokenCount + turnTokens < maxTokens) {
        messages.unshift(...turnMessages);
        tokenCount += turnTokens;
      }
    } else {
      // Use summary for older turns
      const summary = turn.summary || await summarizeTurn(turn);
      messages.unshift(
        { role: 'user', content: turn.request.message },
        { role: 'assistant', content: `[Summary] ${summary}` }
      );
    }
  }
  
  // Add current message
  messages.push({ role: 'user', content: currentMessage });
  
  return messages;
}
```

---

## References

### Copilot Source Files

| File | Purpose |
|------|---------|
| `vscode-copilot-chat-main/src/extension/prompt/common/conversation.ts` | Turn, Conversation, TurnStatus definitions |
| `vscode-copilot-chat-main/src/extension/prompt/common/toolCallRound.ts` | IToolCallRound interface |
| `vscode-copilot-chat-main/src/extension/prompts/node/panel/conversationHistory.tsx` | History rendering with summarization |
| `vscode-copilot-chat-main/src/extension/prompt/common/chatVariablesCollection.ts` | @workspace, @file variables |
| `vscode-copilot-chat-main/src/extension/prompts/node/agent/summarizedConversationHistory.tsx` | Summarized history rendering |

### Aurora Source Files

| File | Purpose |
|------|---------|
| `src/services/agent-service.ts` | Main chat loop and history management |
| `src/services/providers/types.ts` | Message type definitions |
| `src/store/useChatStore.ts` | UI state for messages |
| `src/store/useThreadStore.ts` | Thread persistence |