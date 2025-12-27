# Context Builder Design Analysis

This document provides a comprehensive, accurate, and technically precise explanation of how the KiloCode agentic extension measures tokens, builds context windows, and transmits messages between user ↔ agent ↔ model across multiple messages in a conversation.

## 1. Token Measurement Logic

### How Tokens Are Calculated

The repository implements a multi-layered token counting system with both estimation and actual measurement:

#### Primary Token Counting Implementation

- **Location**: `src/utils/tiktoken.ts` and `src/workers/countTokens.ts`
- **Tokenizer Used**: OpenAI's `tiktoken` library with `o200k_base` encoder (GPT-4o compatible)
- **Token Fudge Factor**: 1.5x multiplier applied to account for estimation inaccuracies

The core token counting function in `src/utils/tiktoken.ts`:

```typescript
export async function tiktoken(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
    // Lazily create and cache the encoder
    if (!encoder) {
        encoder = new Tiktoken(o200kBase.bpe_ranks, o200kBase.special_tokens, o200kBase.pat_str)
    }
    
    let totalTokens = 0
    for (const block of content) {
        if (block.type === "text") {
            const tokens = encoder.encode(block.text || "", undefined, [])
            totalTokens += tokens.length
        } else if (block.type === "image") {
            // Conservative estimation for images
            if (imageSource && typeof imageSource === "object" && "data" in imageSource) {
                const base64Data = imageSource.data as string
                totalTokens += Math.ceil(Math.sqrt(base64Data.length))
            } else {
                totalTokens += 300 // Conservative estimate for unknown images
            }
        }
    }
    
    // Apply 1.5x fudge factor
    return Math.ceil(totalTokens * TOKEN_FUDGE_FACTOR)
}
```

#### Worker-Based Token Counting

- **Implementation**: Uses `workerpool` for non-blocking token counting
- **Location**: `src/utils/countTokens.ts`
- **Configuration**: Max 1 worker, queue size 10
- **Fallback**: Falls back to synchronous counting if worker pool fails

The worker pool is lazily initialized:

```typescript
export async function countTokens(
    content: Anthropic.Messages.ContentBlockParam[],
    { useWorker = true }: CountTokensOptions = {},
): Promise<number> {
    if (useWorker && typeof pool === "undefined") {
        pool = workerpool.pool(__dirname + "/workers/countTokens.js", {
            maxWorkers: 1,
            maxQueueSize: 10,
        })
    }
    
    if (!useWorker || !pool) {
        return tiktoken(content) // Synchronous fallback
    }
    
    try {
        const data = await pool.exec("countTokens", [content])
        const result = countTokensResultSchema.parse(data)
        if (!result.success) {
            throw new Error(result.error)
        }
        return result.count
    } catch (error) {
        pool = null // Reset pool on error
        return tiktoken(content) // Fallback to synchronous
    }
}
```

### Token Counting by Message Type

#### User Messages

- **Location**: `src/core/task/Task.ts` - `submitUserMessage()` and `attemptApiRequest()`
- **Process**: Tokens are counted before sending to API using `apiHandler.countTokens()`
- **Includes**: Text content and image attachments
- **Usage**: Used for context window management before API calls

#### Agent Responses

- **Streaming**: Tokens are tracked incrementally during streaming via `usage` chunks
- **Final Count**: Extracted from API response metadata in `usage` chunks containing:
  - `inputTokens`: Total input tokens (including cache tokens for Anthropic)
  - `outputTokens`: Generated output tokens
  - `cacheWriteTokens`: Cache write tokens (Anthropic only)
  - `cacheReadTokens`: Cache read tokens (Anthropic only)
  - `totalCost`: Calculated cost based on provider pricing
- **Storage**: Token usage is stored in `api_req_started` messages as JSON in the `text` field

The token usage is captured during streaming in `Task.ts`:

```typescript
case "usage": {
    inputTokens = chunk.inputTokens ?? 0
    outputTokens = chunk.outputTokens ?? 0
    cacheWriteTokens = chunk.cacheWriteTokens ?? 0
    cacheReadTokens = chunk.cacheReadTokens ?? 0
    totalCost = chunk.totalCost ?? 0
    
    // Update API request message with usage data
    updateApiReqMsg()
    await this.saveClineMessages()
    await this.updateClineMessage(apiReqMessage)
}
```

#### System Prompts

- **Estimation**: System prompts are counted using the same `tiktoken` encoder
- **Inclusion**: Included in context token calculations via `getSystemPrompt()` in `Task.ts`
- **Location**: System prompt is prepended to conversation history before token counting

#### Context Merges/Summaries

- **Token Count**: Tracked in `condense_context` metadata (`newContextTokens`)
- **Calculation**: After summarization, tokens are recalculated for the condensed context
- **Validation**: System ensures `newContextTokens < prevContextTokens` to prevent context growth
- **Storage**: Stored in `ClineMessage` with `say: "condense_context"` and `contextCondense` metadata

### Determining Remaining Tokens

#### Before Sending Request

The system calculates allowed tokens before each API request in `src/core/context-management/index.ts`:

```typescript
const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS // Default: 8192
const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
const TOKEN_BUFFER_PERCENTAGE = 0.1 // 10% buffer
```

**Calculation Breakdown**:
- `contextWindow`: Model's total context window size (e.g., 128,000 for GPT-4o)
- `TOKEN_BUFFER_PERCENTAGE`: 10% safety buffer to prevent edge cases
- `reservedTokens`: Tokens reserved for model output (default 8192, configurable via `modelMaxTokens`)
- `allowedTokens`: Maximum tokens available for conversation history

#### Token Limits and Truncation

- **Soft Limits**: Uses percentage-based thresholds (default 100%, configurable per profile)
  - Profile-specific thresholds: `profileThresholds[currentProfileId]` (5-100% range)
  - Global threshold: `autoCondenseContextPercent` (default 100%)
- **Hard Limits**: Sliding window truncation at 50% removal when context exceeds `allowedTokens`
- **Reserved Tokens**: Default 8192 tokens for model output (configurable via `modelMaxTokens` in provider settings)
- **Forced Reduction**: 75% reduction when context window exceeded during API call (handles API errors)

### Token Cost Display

- **UI Component**: `webview-ui/src/components/chat/ContextWindowProgress.tsx`
- **Display Format**: Shows used tokens / total context window (e.g., "45,231 / 128,000")
- **Real-time Updates**: Updates during streaming with actual API-reported token usage
- **Tooltip**: Shows breakdown of:
  - Tokens used (current context)
  - Reserved for output (model response capacity)
  - Available space (remaining capacity)

The token distribution calculation in `webview-ui/src/utils/model-utils.ts`:

```typescript
export const calculateTokenDistribution = (
    contextWindow: number,
    contextTokens: number,
    maxTokens?: number,
): TokenDistributionResult => {
    const reservedForOutput = maxTokens && maxTokens > 0 && maxTokens !== contextWindow 
        ? maxTokens 
        : ANTHROPIC_DEFAULT_MAX_TOKENS
    
    const availableSize = Math.max(0, contextWindow - contextTokens - reservedForOutput)
    
    return {
        currentPercent: (contextTokens / contextWindow) * 100,
        reservedPercent: (reservedForOutput / contextWindow) * 100,
        availablePercent: (availableSize / contextWindow) * 100,
        reservedForOutput,
        availableSize,
    }
}
```

## 2. Message Flow Architecture

### 2.1 User Sends First Message

#### Frontend Message Collection

- **Component**: `webview-ui/src/components/chat/ChatTextArea.tsx`
- **Input Handling**: Supports text and image attachments (max 20 images per message)
- **Validation**: Trims whitespace, requires non-empty content
- **State Management**: React state in `ChatView` component

#### Message Serialization

When user submits a message, `ChatView.tsx` handles it:

```typescript
const handleSendMessage = async (messageText: string, imageDataUrls: string[]) => {
    vscode.postMessage({
        type: "newTask", // or "addUserMessage" for existing tasks
        text: messageText,
        images: imageDataUrls,
    })
}
```

#### API Request Body Construction

- **Metadata Included**: 
  - `text`: User message content
  - `images`: Base64-encoded image data URLs
  - `timestamp`: Message timestamp (`ts`)
  - `role`: "user"
- **Tool Signals**: Not applicable for initial messages
- **Attachments**: Images serialized as base64 data URLs in `Anthropic.Messages.ImageBlockParam` format

#### Backend Message Processing

- **Handler**: `src/core/webview/webviewMessageHandler.ts` - case "newTask"
- **Task Creation**: `provider.createTask(message.text, message.images)`
- **Initial Storage**: 
  - Creates new `Task` instance
  - Initializes empty `apiConversationHistory: ApiMessage[]`
  - Initializes empty `clineMessages: ClineMessage[]`
  - Creates task directory for persistence

### 2.2 Agent Replies

#### Streaming Response Delivery

- **Protocol**: Uses `ApiStream` interface (AsyncGenerator) with chunk-based delivery
- **Chunk Types**: Defined in `src/api/transform/stream.ts`:
  - `text`: Incremental text content
  - `usage`: Token usage and cost information
  - `reasoning`: Reasoning tokens (for reasoning models)
  - `tool_use`: Tool call blocks
  - `tool_result`: Tool execution results
  - `grounding`: Grounding sources (RAG results)
  - `error`: Error information

- **Real-time UI Updates**: Updates chat interface incrementally as chunks arrive

The streaming loop in `Task.ts`:

```typescript
for await (const chunk of stream) {
    switch (chunk.type) {
        case "text":
            assistantMessage += chunk.text
            // Update UI with partial content
            presentAssistantMessage(this)
            break
        case "usage":
            // Update token counters
            inputTokens = chunk.inputTokens ?? 0
            outputTokens = chunk.outputTokens ?? 0
            updateApiReqMsg()
            await this.updateClineMessage(apiReqMessage)
            break
        // ... other chunk types
    }
}
```

#### Token Counting During Streaming

- **Incremental Counting**: Tokens accumulated as `usage` chunks arrive
- **Final Usage**: Extracted from final `usage` chunk containing:
  - `inputTokens`: Total input tokens
  - `outputTokens`: Generated tokens
  - `cacheWrites`: Cache write tokens (Anthropic)
  - `cacheReads`: Cache read tokens (Anthropic)
  - `totalCost`: Calculated cost
- **Background Collection**: System continues draining stream in background for up to 5 seconds to capture final usage data

The background usage collection in `Task.ts`:

```typescript
const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
    const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS // 5000ms
    let usageFound = false
    
    while (!item.done && performance.now() - startTime < timeoutMs) {
        const chunk = await iterator.next()
        if (chunk.value?.type === "usage") {
            await captureUsageData({
                input: chunk.value.inputTokens,
                output: chunk.value.outputTokens,
                cacheWrite: chunk.value.cacheWriteTokens,
                cacheRead: chunk.value.cacheReadTokens,
                total: chunk.value.totalCost,
            }, apiReqIndex)
            usageFound = true
        }
    }
}
```

#### Message Storage Architecture

**Dual Storage System**:

1. **`clineMessages`**: UI-visible messages for webview display
   - Type: `ClineMessage[]`
   - Format: Includes `say`, `ask`, `text`, `images`, `ts`, `partial` flags
   - Purpose: What users see in the chat interface

2. **`apiConversationHistory`**: API-formatted messages sent to model
   - Type: `ApiMessage[]`
   - Format: `{ role: "user" | "assistant", content: string | ContentBlockParam[], ts: number }`
   - Purpose: Exact messages sent to the API

**Storage Locations**:

- **Memory**: Active task state in `Task` class instances
- **Persistence**: JSON files in task directories:
  - `apiConversationHistory.json`: API message history
  - `clineMessages.json`: UI message history
  - `taskMetadata.json`: Task metadata

**Message Structure**:

```typescript
interface ApiMessage {
    role: "user" | "assistant"
    content: string | Anthropic.Messages.ContentBlockParam[]
    ts: number
    isSummary?: boolean
    condenseId?: string
    condenseParent?: string
    truncationParent?: string
    isTruncationMarker?: boolean
    truncationId?: string
    type?: "reasoning"
    encrypted_content?: string
    reasoning_details?: any[]
}

interface ClineMessage {
    ts: number
    type: "say" | "ask"
    say?: ClineSay
    ask?: ClineAsk
    text?: string
    images?: string[]
    partial?: boolean
    contextCondense?: ContextCondense
    contextTruncation?: ContextTruncation
}
```

## 3. Context Window Construction

### Previous Message Inclusion Strategy

#### Full Transcript vs. Selective Inclusion

- **Default**: Includes all messages via `getEffectiveApiHistory(apiConversationHistory)`
- **Filtered History**: Removes condensed and truncated messages through parent tagging
- **Non-Destructive**: Messages are tagged, not deleted, enabling rewind operations

The effective history filtering in `src/core/condense/index.ts`:

```typescript
export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
    // Collect all condenseIds of summaries that exist
    const existingSummaryIds = new Set<string>()
    const existingTruncationIds = new Set<string>()
    
    for (const msg of messages) {
        if (msg.isSummary && msg.condenseId) {
            existingSummaryIds.add(msg.condenseId)
        }
        if (msg.isTruncationMarker && msg.truncationId) {
            existingTruncationIds.add(msg.truncationId)
        }
    }
    
    // Filter out messages whose parent points to an existing summary/marker
    return messages.filter((msg) => {
        if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
            return false // Hidden by summary
        }
        if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
            return false // Hidden by truncation
        }
        return true
    })
}
```

#### Context Building Process

The context building flow in `Task.ts` - `attemptApiRequest()`:

1. **Retrieve Effective History**: `getEffectiveApiHistory(apiConversationHistory)`
   - Filters out messages tagged with `condenseParent` or `truncationParent`

2. **Filter by Summary**: `getMessagesSinceLastSummary(effectiveHistory)`
   - Returns messages since the last summary (or all if no summary exists)
   - Always includes the first message (task instructions)

3. **Remove Images**: `maybeRemoveImageBlocks(messagesSinceLastSummary, apiHandler)`
   - Removes image blocks from context when sending to API
   - Images are preserved in UI but excluded from API calls to save tokens

4. **Clean Conversation**: `buildCleanConversationHistory(filteredMessages)`
   - Converts `ApiMessage[]` to `Anthropic.Messages.MessageParam[]`
   - Handles reasoning blocks (encrypted vs plain text)
   - Handles `reasoning_details` for OpenRouter Gemini models

### Context Management Methods

#### Sliding Window Truncation

- **Trigger**: When context tokens exceed `allowedTokens` and summarization fails or is disabled
- **Method**: `truncateConversation(messages, 0.5, taskId)` in `src/core/context-management/index.ts`
- **Algorithm**: 
  - Removes 50% of visible messages (excluding first message)
  - Tags removed messages with `truncationParent: truncationId`
  - Inserts truncation marker with summary of hidden messages
  - Ensures even number of messages removed (maintains user/assistant pairing)

The truncation implementation:

```typescript
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
    const truncationId = crypto.randomUUID()
    
    // Filter to only visible messages (not already truncated)
    const visibleIndices: number[] = []
    messages.forEach((msg, index) => {
        if (!msg.truncationParent && !msg.isTruncationMarker) {
            visibleIndices.push(index)
        }
    })
    
    // Calculate how many visible messages to truncate (excluding first)
    const visibleCount = visibleIndices.length
    const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
    const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2) // Ensure even
    
    // Tag messages with truncationParent
    const taggedMessages = messages.map((msg, index) => {
        if (indicesToTruncate.has(index)) {
            return { ...msg, truncationParent: truncationId }
        }
        return msg
    })
    
    // Insert truncation marker
    const truncationMarker: ApiMessage = {
        role: "user",
        content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
        ts: firstKeptTs - 1,
        isTruncationMarker: true,
        truncationId,
    }
    
    return { messages: result, truncationId, messagesRemoved: messagesToRemove }
}
```

#### Summarization-Based Memory

- **Trigger**: Automatic at configurable percentage thresholds (default 100%, range 5-100%)
- **Method**: `summarizeConversation()` in `src/core/condense/index.ts`
- **Algorithm**: 
  - Keeps last 3 messages (`N_MESSAGES_TO_KEEP = 3`)
  - Summarizes remainder using LLM call with custom prompt
  - Preserves tool_use/tool_result pairing for native tools protocol
  - Validates that `newContextTokens < prevContextTokens` to prevent growth

The summarization process:

```typescript
export async function summarizeConversation(
    messages: ApiMessage[],
    apiHandler: ApiHandler,
    systemPrompt: string,
    taskId: string,
    prevContextTokens: number,
    isAutomaticTrigger?: boolean,
    customCondensingPrompt?: string,
    condensingApiHandler?: ApiHandler,
    useNativeTools?: boolean,
): Promise<SummarizeResponse> {
    // Always preserve the first message
    const firstMessage = messages[0]
    
    // Get last N messages to keep (default: 3)
    const { keepMessages, toolUseBlocksToPreserve } = useNativeTools
        ? getKeepMessagesWithToolBlocks(messages, N_MESSAGES_TO_KEEP)
        : { keepMessages: messages.slice(-N_MESSAGES_TO_KEEP), toolUseBlocksToPreserve: [] }
    
    // Get messages to summarize (excluding first and last N)
    const messagesToSummarize = getMessagesSinceLastSummary(
        messages.slice(0, messages.length - N_MESSAGES_TO_KEEP)
    )
    
    // Create summarization request
    const requestMessages = maybeRemoveImageBlocks(
        [...messagesToSummarize, finalRequestMessage],
        apiHandler
    )
    
    // Call LLM to generate summary
    const stream = handlerToUse.createMessage(promptToUse, requestMessages)
    let summary = ""
    let outputTokens = 0
    
    for await (const chunk of stream) {
        if (chunk.type === "text") {
            summary += chunk.text
        } else if (chunk.type === "usage") {
            outputTokens = chunk.outputTokens ?? 0
        }
    }
    
    // Build summary message with tool_use blocks if needed
    const summaryMessage: ApiMessage = {
        role: "assistant",
        content: toolUseBlocksToPreserve.length > 0
            ? [{ type: "text", text: summary }, ...toolUseBlocksToPreserve]
            : summary,
        ts: firstKeptTs - 1,
        isSummary: true,
        condenseId: crypto.randomUUID(),
    }
    
    // Tag middle messages with condenseParent (non-destructive)
    const newMessages = messages.map((msg, index) => {
        if (index === 0) return msg // First message stays
        if (index >= keepStartIndex) return msg // Last N messages stay
        if (!msg.condenseParent) {
            return { ...msg, condenseParent: condenseId }
        }
        return msg
    })
    
    // Insert summary before keep messages
    newMessages.splice(keepStartIndex, 0, summaryMessage)
    
    // Validate context didn't grow
    const newContextTokens = outputTokens + (await apiHandler.countTokens(contextBlocks))
    if (newContextTokens >= prevContextTokens) {
        return { error: "Context grew after condensation", ... }
    }
    
    return { messages: newMessages, summary, cost, newContextTokens, condenseId }
}
```

#### Retrieval/RAG

- **Not Implemented**: Repository uses transcript-based context only
- **No Vector Search**: No semantic search or retrieval-augmented generation
- **No Embeddings**: No embedding-based similarity search

#### Hybrid Compressed Context

- **Implementation**: Combines summarization + sliding window as fallback
- **Order**: Attempts summarization first, falls back to truncation if summarization fails
- **Location**: `manageContext()` in `src/core/context-management/index.ts`

The context management flow:

```typescript
export async function manageContext({
    messages,
    totalTokens,
    contextWindow,
    maxTokens,
    apiHandler,
    autoCondenseContext,
    autoCondenseContextPercent,
    systemPrompt,
    taskId,
    customCondensingPrompt,
    condensingApiHandler,
    profileThresholds,
    currentProfileId,
    useNativeTools,
}: ContextManagementOptions): Promise<ContextManagementResult> {
    const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
    const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
    
    // Calculate effective threshold (profile-specific or global)
    let effectiveThreshold = autoCondenseContextPercent
    const profileThreshold = profileThresholds[currentProfileId]
    if (profileThreshold !== undefined && profileThreshold >= MIN_CONDENSE_THRESHOLD) {
        effectiveThreshold = profileThreshold
    }
    
    // Try summarization first if enabled and threshold reached
    if (autoCondenseContext) {
        const contextPercent = (100 * prevContextTokens) / contextWindow
        if (contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
            const result = await summarizeConversation(...)
            if (!result.error) {
                return { ...result, prevContextTokens }
            }
            // Fall through to truncation if summarization fails
        }
    }
    
    // Fall back to sliding window truncation if needed
    if (prevContextTokens > allowedTokens) {
        const truncationResult = truncateConversation(messages, 0.5, taskId)
        return {
            messages: truncationResult.messages,
            prevContextTokens,
            truncationId: truncationResult.truncationId,
            messagesRemoved: truncationResult.messagesRemoved,
        }
    }
    
    // No truncation or condensation needed
    return { messages, summary: "", cost: 0, prevContextTokens, error: undefined }
}
```

### Context Building Decisions

#### What to Keep

- **First Message**: Always preserved (contains task instructions)
- **Recent Messages**: Last N messages (N=3 for summarization)
- **Uncondensed Messages**: Messages not tagged with `condenseParent`
- **Untruncated Messages**: Messages not tagged with `truncationParent`
- **Tool Pairing**: When using native tools protocol, preserves `tool_use` blocks needed for `tool_result` blocks

#### What to Drop/Compress

- **Automatic Condensation**: Messages beyond keep threshold when context usage exceeds percentage
- **Sliding Window**: 50% of visible messages when condensation unavailable/fails
- **Image Removal**: Images removed from context when sending to API (preserved in UI)
- **Orphaned Messages**: Messages whose summary/truncation marker was deleted are restored (via `cleanupAfterTruncation()`)

#### What to Compress

- **Summarization Content**: Full conversation history since last summary
- **Tool History**: Preserves tool_use blocks when using native tools protocol
- **Truncation Markers**: Inserted to track where messages were hidden

### Token Limit Application

#### Pre-Request Context Validation

Before each API request in `Task.ts` - `attemptApiRequest()`:

```typescript
const { contextTokens } = this.getTokenUsage()
const maxTokens = getModelMaxOutputTokens({ modelId, model: modelInfo, settings })
const contextWindow = this.api.contextWindow ?? modelInfo.contextWindow

if (contextTokens) {
    const truncateResult = await manageContext({
        messages: this.apiConversationHistory,
        totalTokens: contextTokens,
        maxTokens,
        contextWindow,
        apiHandler: this.api,
        autoCondenseContext,
        autoCondenseContextPercent,
        systemPrompt,
        taskId,
        customCondensingPrompt,
        condensingApiHandler,
        profileThresholds,
        currentProfileId,
        useNativeTools,
    })
    
    if (truncateResult.messages !== this.apiConversationHistory) {
        await this.overwriteApiConversationHistory(truncateResult.messages)
    }
}
```

#### Dynamic Trimming

- **Automatic**: Triggered when context exceeds threshold (percentage-based or hard limit)
- **Forced**: 75% reduction when context window exceeded during API call (handles API errors)
- **Reversible**: Tagged messages can be restored via rewind operations

The forced reduction on API error:

```typescript
private async handleContextWindowExceededError() {
    const truncateResult = await manageContext({
        messages: this.apiConversationHistory,
        totalTokens: contextTokens || 0,
        maxTokens,
        contextWindow,
        apiHandler: this.api,
        autoCondenseContext: true,
        autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT, // 75%
        systemPrompt: await this.getSystemPrompt(),
        taskId: this.taskId,
        profileThresholds,
        currentProfileId,
        useNativeTools,
    })
}
```

## 4. Interface Updates & Token UI

### Token Usage Display

#### State Storage

- **Frontend**: React state in `ChatView` component, calculated via `getApiMetrics(modifiedMessages)`
- **Backend**: Calculated from `clineMessages` using `getApiMetrics()` in `src/shared/getApiMetrics.ts`
- **Persistence**: Token usage stored in message metadata (`api_req_started` messages with JSON text)

The token usage calculation:

```typescript
export function getApiMetrics(messages: ClineMessage[]) {
    const result: TokenUsage = {
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCacheWrites: undefined,
        totalCacheReads: undefined,
        totalCost: 0,
        contextTokens: 0,
    }
    
    // Sum up tokens from all api_req_started messages
    messages.forEach((message) => {
        if (message.type === "say" && message.say === "api_req_started" && message.text) {
            const parsedText = JSON.parse(message.text)
            result.totalTokensIn += parsedText.tokensIn ?? 0
            result.totalTokensOut += parsedText.tokensOut ?? 0
            result.totalCacheWrites = (result.totalCacheWrites ?? 0) + (parsedText.cacheWrites ?? 0)
            result.totalCacheReads = (result.totalCacheReads ?? 0) + (parsedText.cacheReads ?? 0)
            result.totalCost += parsedText.cost ?? 0
        } else if (message.type === "say" && message.say === "condense_context") {
            result.totalCost += message.contextCondense?.cost ?? 0
        }
    })
    
    // Get context tokens from last API request or condense
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.type === "say" && message.say === "api_req_started" && message.text) {
            const parsedText = JSON.parse(message.text)
            result.contextTokens = (parsedText.tokensIn || 0) + (parsedText.tokensOut || 0)
            break
        } else if (message.type === "say" && message.say === "condense_context") {
            result.contextTokens = message.contextCondense?.newContextTokens ?? 0
            break
        }
    }
    
    return result
}
```

#### Real-time Updates

- **During Streaming**: Incremental token counting from API `usage` chunks
- **Post-Response**: Final token usage from API response metadata
- **UI Refresh**: Automatic re-render via React state updates when `clineMessages` change
- **Background Collection**: System continues draining stream for up to 5 seconds to capture final usage

The real-time update flow:

1. Stream chunk arrives with `type: "usage"`
2. `Task.ts` updates `inputTokens`, `outputTokens`, etc.
3. `updateApiReqMsg()` updates the `api_req_started` message text
4. `saveClineMessages()` persists to disk
5. `updateClineMessage()` sends update to webview
6. `ChatView` recalculates `apiMetrics` via `getApiMetrics()`
7. `ContextWindowProgress` component re-renders with new values

#### Error Handling

- **Context Window Exceeded**: Shows warning in VSCode notification, triggers forced 75% reduction
- **Token Counting Failures**: Falls back to estimation, logs errors to console
- **API Failures**: Displays error messages in chat interface, allows retry
- **Summarization Failures**: Falls back to sliding window truncation

### Token Progress Visualization

#### Progress Bar Components

- **Primary**: `ContextWindowProgress` component in `webview-ui/src/components/chat/ContextWindowProgress.tsx`
- **Segments**: 
  - Used tokens (dark): Current context tokens
  - Reserved for output (medium): Tokens reserved for model response
  - Available space (transparent): Remaining capacity
- **Colors**: Uses VSCode theme colors with opacity variations
- **Display**: Shows "45,231 / 128,000" format with tooltip breakdown

The component implementation:

```typescript
export const ContextWindowProgress = ({ contextWindow, contextTokens, maxTokens }) => {
    const tokenDistribution = useMemo(
        () => calculateTokenDistribution(contextWindow, contextTokens, maxTokens),
        [contextWindow, contextTokens, maxTokens]
    )
    
    const { currentPercent, reservedPercent, availableSize, reservedForOutput } = tokenDistribution
    
    return (
        <div className="flex items-center gap-2">
            <div>{formatLargeNumber(contextTokens)}</div>
            <div className="flex-1 relative">
                {/* Progress bar with three segments */}
                <div className="flex items-center h-1 rounded overflow-hidden">
                    {/* Current tokens - darkest */}
                    <div style={{ width: `${currentPercent}%` }}>
                        <KiloContextWindowProgressTokensUsed currentPercent={currentPercent} />
                    </div>
                    {/* Reserved for output - medium */}
                    <div style={{ width: `${reservedPercent}%` }}>
                        <div className="h-full bg-[color-mix(in_srgb,var(--vscode-foreground)_30%,transparent)]" />
                    </div>
                    {/* Available space - transparent */}
                    {availablePercent > 0 && (
                        <div style={{ width: `${availablePercent}%` }} />
                    )}
                </div>
            </div>
            <div>{formatLargeNumber(contextWindow)}</div>
        </div>
    )
}
```

#### Token Distribution Calculation

The calculation in `webview-ui/src/utils/model-utils.ts`:

```typescript
export const calculateTokenDistribution = (
    contextWindow: number,
    contextTokens: number,
    maxTokens?: number,
): TokenDistributionResult => {
    const safeContextWindow = Math.max(0, contextWindow)
    const safeContextTokens = Math.max(0, contextTokens)
    
    const reservedForOutput = maxTokens && maxTokens > 0 && maxTokens !== safeContextWindow
        ? maxTokens
        : ANTHROPIC_DEFAULT_MAX_TOKENS // 8192
    
    const availableSize = Math.max(0, safeContextWindow - safeContextTokens - reservedForOutput)
    
    return {
        currentPercent: (safeContextTokens / safeContextWindow) * 100,
        reservedPercent: (reservedForOutput / safeContextWindow) * 100,
        availablePercent: (availableSize / safeContextWindow) * 100,
        reservedForOutput,
        availableSize,
    }
}
```

## 5. Complete Architecture Overview

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Webview UI Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ ChatTextArea │  │   ChatView   │  │ ContextWindowProgress │ │
│  │              │  │              │  │                      │ │
│  │ - Input     │──▶│ - State      │──▶│ - Token Display      │ │
│  │ - Images    │  │ - Messages   │  │ - Progress Bar       │ │
│  └──────────────┘  └──────────────┘  └──────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │ vscode.postMessage()
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Extension Host Layer                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              webviewMessageHandler                        │  │
│  │  - Handles "newTask", "addUserMessage"                   │  │
│  │  - Routes to ClineProvider                               │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                         │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │                    ClineProvider                         │  │
│  │  - Task Management                                       │  │
│  │  - State Coordination                                    │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                         │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │                      Task                                │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │ - submitUserMessage()                           │   │  │
│  │  │ - attemptApiRequest()                           │   │  │
│  │  │ - Stream Processing                             │   │  │
│  │  │ - Message Storage                               │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  │                                                          │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │         Context Management                       │   │  │
│  │  │  - manageContext()                               │   │  │
│  │  │  - summarizeConversation()                      │   │  │
│  │  │  - truncateConversation()                      │   │  │
│  │  │  - getEffectiveApiHistory()                    │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  │                                                          │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │         Token Counting                            │   │  │
│  │  │  - countTokens() (worker-based)                  │   │  │
│  │  │  - tiktoken() (synchronous fallback)             │   │  │
│  │  │  - getTokenUsage()                                │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                        │                                         │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │                    ApiHandler                           │  │
│  │  - createMessage() → ApiStream                         │  │
│  │  - countTokens()                                        │  │
│  │  - getModel() → ModelInfo                               │  │
│  └────────────────────┬─────────────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────────┘
                           │ HTTP/WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Model Providers                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  Anthropic  │  │   OpenAI     │  │   OpenRouter         │ │
│  │  Handler    │  │   Handler    │  │   Handler            │ │
│  └──────────────┘  └──────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Persistence Layer                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Task Directory Structure                                │  │
│  │  - apiConversationHistory.json                           │  │
│  │  - clineMessages.json                                   │  │
│  │  - taskMetadata.json                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Module-by-Module Breakdown

#### tokenizer (`src/utils/tiktoken.ts`, `src/workers/countTokens.ts`)

- **Purpose**: Count tokens in message content
- **Implementation**: tiktoken with o200k_base encoder, 1.5x fudge factor
- **Performance**: Worker-based for non-blocking operation
- **Fallback**: Synchronous counting on worker failure
- **Image Handling**: Conservative estimation using `Math.ceil(Math.sqrt(base64Data.length))`

#### message-manager (`src/core/message-manager/index.ts`)

- **Purpose**: Centralized rewind operations for conversation history
- **Key Methods**: `rewindToTimestamp()`, `rewindToIndex()`
- **Safety**: Maintains linkage between UI and API histories
- **Cleanup**: Removes orphaned summaries and truncation markers via `cleanupAfterTruncation()`

#### context-builder (`src/core/context-management/index.ts`, `src/core/condense/index.ts`)

- **Purpose**: Manage context size through summarization and truncation
- **Methods**: 
  - `manageContext()`: Main entry point, coordinates condensation/truncation
  - `summarizeConversation()`: LLM-based summarization
  - `truncateConversation()`: Sliding window truncation
  - `getEffectiveApiHistory()`: Filters tagged messages
  - `getMessagesSinceLastSummary()`: Gets messages since last summary
- **Triggers**: Percentage-based thresholds, hard limits
- **Fallback**: Sliding window truncation when summarization fails

#### model-router (`src/api/`)

- **Purpose**: Abstract API communication with different providers
- **Streaming**: Chunk-based response delivery via `ApiStream` (AsyncGenerator)
- **Token Tracking**: Extracts usage from API responses via `usage` chunks
- **Context Limits**: Enforces provider-specific constraints
- **Providers**: Anthropic, OpenAI, OpenRouter, Bedrock, Vertex, Gemini, etc.

#### UI Update Cycle (`webview-ui/src/components/chat/`)

- **Components**: `ChatView`, `ContextWindowProgress`, `TaskHeader`
- **State**: React state with VSCode message passing
- **Updates**: Real-time during streaming, post-response finalization
- **Visualization**: Progress bars, token counters, tooltips
- **Metrics**: Calculated via `getApiMetrics()` from `clineMessages`

### Data Structures

#### Message Types

```typescript
interface ClineMessage {
    ts: number
    type: "say" | "ask"
    say?: ClineSay // "api_req_started", "condense_context", "sliding_window_truncation", etc.
    ask?: ClineAsk // "tool", "payment_required_prompt", etc.
    text?: string // JSON string for api_req_started, plain text for others
    images?: string[]
    partial?: boolean
    contextCondense?: ContextCondense
    contextTruncation?: ContextTruncation
}

interface ApiMessage {
    role: "user" | "assistant"
    content: string | Anthropic.Messages.ContentBlockParam[]
    ts: number
    isSummary?: boolean
    condenseId?: string
    condenseParent?: string
    truncationParent?: string
    isTruncationMarker?: boolean
    truncationId?: string
    type?: "reasoning"
    encrypted_content?: string
    reasoning_details?: any[]
}

interface ContextCondense {
    summary: string
    cost: number
    newContextTokens: number
    prevContextTokens: number
    condenseId?: string
}

interface ContextTruncation {
    truncationId: string
    messagesRemoved: number
    prevContextTokens: number
}
```

#### Context Window State

```typescript
interface TokenDistributionResult {
    currentPercent: number // Percentage used by current tokens (0-100)
    reservedPercent: number // Percentage reserved for output (0-100)
    availablePercent: number // Percentage still available (0-100)
    reservedForOutput: number // Tokens reserved for model output
    availableSize: number // Tokens still available
}

interface TokenUsage {
    contextTokens: number // Current context size (input + output from last request)
    totalTokensIn: number // Cumulative input tokens
    totalTokensOut: number // Cumulative output tokens
    totalCacheWrites?: number // Cumulative cache writes (Anthropic)
    totalCacheReads?: number // Cumulative cache reads (Anthropic)
    totalCost: number // Cumulative cost in USD
}
```

#### Token Counters

```typescript
interface ApiStreamUsageChunk {
    type: "usage"
    inputTokens: number
    outputTokens: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
    totalCost?: number
    inferenceProvider?: string
}

interface ParsedApiReqStartedTextType {
    tokensIn: number
    tokensOut: number
    cacheWrites: number
    cacheReads: number
    cost?: number
    apiProtocol?: "anthropic" | "openai"
}
```

### Safe, Efficient, Reversible Context Building

#### Safety Mechanisms

- **Non-Destructive Operations**: Messages tagged rather than deleted
  - `condenseParent`: Links messages to their summary
  - `truncationParent`: Links messages to their truncation marker
  - Enables full restoration via rewind operations

- **Rewind Capability**: Full conversation restoration via timestamp/index
  - `MessageManager.rewindToTimestamp()`: Restores to specific point
  - `MessageManager.rewindToIndex()`: Restores to message index
  - `cleanupAfterTruncation()`: Clears orphaned parent references

- **Error Recovery**: Fallback from summarization to truncation
  - If summarization fails, falls back to sliding window truncation
  - If truncation fails, system logs error and continues with available context

- **Buffer Zones**: 10% token buffer prevents edge case failures
  - `TOKEN_BUFFER_PERCENTAGE = 0.1`
  - Prevents hitting exact context window limits

- **Validation**: Ensures context doesn't grow after condensation
  - Checks `newContextTokens < prevContextTokens`
  - Returns error if condensation would increase context size

#### Efficiency Optimizations

- **Lazy Worker Creation**: Token counting workers created on demand
  - Worker pool initialized only when first `countTokens()` call occurs
  - Reduces startup overhead

- **Incremental Updates**: Token counts updated during streaming
  - Updates `api_req_started` message as `usage` chunks arrive
  - UI updates in real-time without waiting for stream completion

- **Caching**: Encoder instances cached for reuse
  - `tiktoken` encoder created once and reused
  - Reduces initialization overhead

- **Selective Processing**: Only processes changed content
  - `getEffectiveApiHistory()` filters efficiently using Set lookups
  - Only processes messages since last summary

- **Background Collection**: Continues draining stream for final usage
  - Up to 5 seconds timeout to capture final `usage` chunk
  - Doesn't block main streaming flow

#### Reversibility Features

- **Parent Tagging**: `condenseParent`, `truncationParent` enable restoration
  - Messages tagged but not deleted
  - Can be restored by removing parent summary/marker

- **Summary Linking**: `condenseId` connects summaries to replaced content
  - Each summary has unique `condenseId`
  - Messages reference summary via `condenseParent`

- **Marker Tracking**: `truncationId` links truncation markers to hidden content
  - Each truncation has unique `truncationId`
  - Messages reference truncation via `truncationParent`

- **Timestamp Ordering**: Maintains chronological integrity for rewinds
  - All messages have `ts` timestamp
  - Rewind operations preserve chronological order

- **Cleanup Functions**: `cleanupAfterTruncation()` restores orphaned messages
  - When summary/marker deleted, clears parent references
  - Messages become active again automatically

## Summary

The KiloCode extension implements a sophisticated, non-destructive context management system that:

1. **Accurately measures tokens** using tiktoken with worker-based counting and 1.5x fudge factor
2. **Manages context efficiently** through intelligent summarization (preferred) and sliding window truncation (fallback)
3. **Preserves conversation history** through tagging rather than deletion, enabling full rewind capabilities
4. **Updates UI in real-time** during streaming with incremental token tracking
5. **Handles errors gracefully** with fallback mechanisms and forced reductions when needed

The system ensures context windows remain within model limits while preserving conversation continuity and enabling users to rewind to any point in the conversation history.

