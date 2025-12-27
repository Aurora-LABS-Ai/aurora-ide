# How I (Claude) Actually Use Tools: Step-by-Step Process

This document shows the **exact tool calls** I make when working with your codebase. No abstractions - just the real process.

---

## Example: "Add error handling to handleSend function"

### Step 1: Find the function

**Tool Call:**
```typescript
grep({
  pattern: "const.*handleSend|function.*handleSend|handleSend.*=",
  type: "tsx",
  path: "src/components/chat"
})
```

**Result I Get:**
```
src/components/chat\ChatPanel.tsx
143:  const handleSend = useCallback(
630:      <ChatInput onSend={handleSend} disabled={isLoading} />
```

**What I Learn:**
- Function is at line 143 in `ChatPanel.tsx`
- It's a `useCallback`
- It's used at line 630

---

### Step 2: Read the function to understand it

**Tool Call:**
```typescript
read_file({
  target_file: "src/components/chat/ChatPanel.tsx",
  offset: 143,    // Start at line 143
  limit: 100      // Read 100 lines
})
```

**Result I Get:**
```
143|  const handleSend = useCallback(
144|    async (content: string) => {
145|      // Reset timeline
146|      timelineRef.current = [];
147|
148|      // Ensure we have a thread
149|      let threadId = currentThreadId;
150|      if (!threadId) {
151|        threadId = createThread();
152|      }
...
198|      });
199|
200|      // Create a new assistant message that we'll stream into
201|      const assistantMessageId = generateId();
```

**What I Learn:**
- Function starts at line 143
- It's an async function
- I need to see where it ends

---

### Step 3: Find where the function ends

**Tool Call:**
```typescript
grep({
  pattern: "^  },|^  \\);",
  path: "src/components/chat/ChatPanel.tsx",
  -A: 3,  // Show 3 lines after match
  -B: 3   // Show 3 lines before match
})
```

**Result I Get:**
```
280|      } catch (error) {
281|        console.error("Error in handleSend:", error);
282|        setLoading(false);
283|      }
284|    },
285|    [currentThreadId, createThread, addMessageToThread, ...]
286|  );
```

**What I Learn:**
- Function ends at line 286
- There's already a try-catch at line 280
- Dependencies are at line 285

---

### Step 4: Read more context to see the full function

**Tool Call:**
```typescript
read_file({
  target_file: "src/components/chat/ChatPanel.tsx",
  offset: 143,
  limit: 150  // Read enough to see the whole function
})
```

**Result:** I see the complete function from lines 143-286.

---

### Step 5: Check for related code (imports, types)

**Tool Call:**
```typescript
read_file({
  target_file: "src/components/chat/ChatPanel.tsx",
  offset: 1,
  limit: 50  // Read imports and types
})
```

**Result I Get:**
```
1|import React, { useRef, useCallback, useState, useEffect } from "react";
2|import { ChatHistory } from "./ChatHistory";
...
13|import type {
14|  ToolProposal,
15|  ToolCall,
16|  Message,
17|  TimelineEvent,
18|} from "../../types";
```

**What I Learn:**
- `Message` type is imported
- I can use it for error messages

---

### Step 6: Make the replacement

**Tool Call:**
```typescript
search_replace({
  file_path: "src/components/chat/ChatPanel.tsx",
  old_string: `      } catch (error) {
        console.error("Error in handleSend:", error);
        setLoading(false);
      }`,
  new_string: `      } catch (error) {
        console.error("Error in handleSend:", error);
        setLoading(false);
        
        // Add error message to thread
        const errorMessage: Message = {
          id: generateId(),
          sender: "assistant",
          content: `An error occurred: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
        };
        addMessageToThread(errorMessage);
      }`
})
```

**What Happens:**
- Exact string match found
- Replacement made
- File updated

---

### Step 7: Verify no errors

**Tool Call:**
```typescript
read_lints({
  paths: ["src/components/chat/ChatPanel.tsx"]
})
```

**Result:** No errors (or I see what needs fixing)

---

## Complete Real Example: Finding and Replacing useState

### Scenario: "Replace useState with useChatStore"

### Step 1: Find all useState in the file

**Tool Call:**
```typescript
grep({
  pattern: "useState",
  path: "src/components/chat/ChatPanel.tsx",
  -B: 2,
  -A: 2
})
```

**Result:**
```
48|  } = useThreadStore();
49|
50|  const { refreshDirectory, rootPath } = useWorkspaceStore();
51|  const [isOpen, setIsOpen] = useState(false);
52|  const [selectedTab, setSelectedTab] = useState<string | null>(null);
53|
54|  useEffect(() => {
```

**What I Learn:**
- Line 51: `const [isOpen, setIsOpen] = useState(false);`
- Line 52: `const [selectedTab, setSelectedTab] = useState<string | null>(null);`

---

### Step 2: Check what's available in useChatStore

**Tool Call:**
```typescript
read_file({
  target_file: "src/store/useChatStore.ts"
})
```

**Result:** I see the store structure and available state.

---

### Step 3: Check how useState is used

**Tool Call:**
```typescript
grep({
  pattern: "isOpen|setIsOpen|selectedTab|setSelectedTab",
  path: "src/components/chat/ChatPanel.tsx"
})
```

**Result:** I see all usages to understand the context.

---

### Step 4: Make replacement

**Tool Call:**
```typescript
search_replace({
  file_path: "src/components/chat/ChatPanel.tsx",
  old_string: `  const { refreshDirectory, rootPath } = useWorkspaceStore();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedTab, setSelectedTab] = useState<string | null>(null);`,
  new_string: `  const { refreshDirectory, rootPath } = useWorkspaceStore();
  const { isOpen, setIsOpen, selectedTab, setSelectedTab } = useChatStore();`
})
```

---

### Step 5: Remove useState import if not used

**Tool Call:**
```typescript
grep({
  pattern: "useState",
  path: "src/components/chat/ChatPanel.tsx"
})
```

If no more useState found:

**Tool Call:**
```typescript
search_replace({
  file_path: "src/components/chat/ChatPanel.tsx",
  old_string: `import React, { useRef, useCallback, useState, useEffect } from "react";`,
  new_string: `import React, { useRef, useCallback, useEffect } from "react";`
})
```

---

## Finding Files: Multiple Strategies

### Strategy 1: Semantic Search (Understanding)

**Tool Call:**
```typescript
codebase_search({
  query: "How does the chat panel handle sending messages?",
  target_directories: ["src/components/chat"]
})
```

**Result:** I get relevant code snippets explaining the flow.

**When to Use:** When I need to understand how something works.

---

### Strategy 2: Exact Pattern Search (Finding)

**Tool Call:**
```typescript
grep({
  pattern: "handleSend",
  type: "tsx"
})
```

**Result:** All files and line numbers where `handleSend` appears.

**When to Use:** When I know exactly what I'm looking for.

---

### Strategy 3: File Pattern Search (Discovery)

**Tool Call:**
```typescript
glob_file_search({
  glob_pattern: "**/*Chat*.tsx"
})
```

**Result:** All files matching the pattern.

**When to Use:** When I want to find related files.

---

## Reading Large Files: Efficient Strategy

### Problem: File is 1000+ lines

**Bad Approach:**
```typescript
read_file({
  target_file: "huge-file.tsx"  // Reads entire file - slow!
})
```

**Good Approach:**
```typescript
// Step 1: Find what I need
grep({
  pattern: "function.*Component|export.*Component",
  path: "huge-file.tsx"
})

// Step 2: Read only that section
read_file({
  target_file: "huge-file.tsx",
  offset: 150,  // Start where function is
  limit: 100    // Read only what I need
})
```

---

## Multi-File Refactoring: Complete Process

### Scenario: "Rename ToolProposal to ToolRequest across the codebase"

### Step 1: Find all occurrences

**Tool Call:**
```typescript
grep({
  pattern: "ToolProposal",
  output_mode: "files_with_matches"
})
```

**Result:**
```
src/types/index.ts
src/components/chat/ToolProposalCard.tsx
src/components/chat/ChatPanel.tsx
src/services/agent-service.ts
```

---

### Step 2: Read each file to understand context

**Tool Calls:**
```typescript
read_file({ target_file: "src/types/index.ts" })
read_file({ target_file: "src/components/chat/ToolProposalCard.tsx" })
read_file({ target_file: "src/components/chat/ChatPanel.tsx" })
read_file({ target_file: "src/services/agent-service.ts" })
```

---

### Step 3: Replace in each file

**Tool Call 1:**
```typescript
search_replace({
  file_path: "src/types/index.ts",
  old_string: "export interface ToolProposal {",
  new_string: "export interface ToolRequest {"
})
```

**Tool Call 2:**
```typescript
search_replace({
  file_path: "src/types/index.ts",
  old_string: "ToolProposal",
  new_string: "ToolRequest",
  replace_all: true  // Replace ALL occurrences
})
```

**Tool Call 3:**
```typescript
search_replace({
  file_path: "src/components/chat/ToolProposalCard.tsx",
  old_string: "ToolProposal",
  new_string: "ToolRequest",
  replace_all: true
})
```

**Tool Call 4:**
```typescript
search_replace({
  file_path: "src/components/chat/ChatPanel.tsx",
  old_string: "ToolProposal",
  new_string: "ToolRequest",
  replace_all: true
})
```

**Tool Call 5:**
```typescript
search_replace({
  file_path: "src/services/agent-service.ts",
  old_string: "ToolProposal",
  new_string: "ToolRequest",
  replace_all: true
})
```

---

### Step 4: Rename the file

**Tool Call:**
```typescript
// Can't rename directly, so:
// 1. Read old file
read_file({ target_file: "src/components/chat/ToolProposalCard.tsx" })

// 2. Write new file
write({
  file_path: "src/components/chat/ToolRequestCard.tsx",
  contents: "// ... content with ToolRequest ..."
})

// 3. Delete old file
delete_file({ target_file: "src/components/chat/ToolProposalCard.tsx" })
```

---

### Step 5: Update imports

**Tool Call:**
```typescript
grep({
  pattern: "ToolProposalCard",
  type: "tsx"
})
```

Then update each import.

---

### Step 6: Verify everything

**Tool Call:**
```typescript
read_lints({
  paths: [
    "src/types/index.ts",
    "src/components/chat/ToolRequestCard.tsx",
    "src/components/chat/ChatPanel.tsx",
    "src/services/agent-service.ts"
  ]
})
```

---

## The Complete "30 Second Refactor" Breakdown

When I said "Done in 30 seconds", here's what actually happens:

### User: "Refactor Button component to TypeScript"

### My Process (all happens automatically):

**0-2 seconds:**
```typescript
glob_file_search({ glob_pattern: "**/Button.*" })
// Result: src/components/Button.jsx
```

**2-4 seconds:**
```typescript
read_file({ target_file: "src/components/Button.jsx" })
// I see the component structure
```

**4-6 seconds:**
```typescript
grep({
  pattern: "import.*Button|from.*Button",
  type: "tsx"
})
// Find where it's imported
```

**6-10 seconds:**
```typescript
read_file({ target_file: "src/components/Button.jsx" })
// Read again to plan the refactor
```

**10-15 seconds:**
```typescript
write({
  file_path: "src/components/Button.tsx",
  contents: "// TypeScript version with proper types..."
})
```

**15-18 seconds:**
```typescript
grep({
  pattern: "Button",
  type: "tsx"
})
// Find imports to update
```

**18-25 seconds:**
```typescript
search_replace({
  file_path: "src/App.tsx",
  old_string: "import Button from './components/Button.jsx'",
  new_string: "import Button from './components/Button'"
})
// Update imports (multiple files)
```

**25-28 seconds:**
```typescript
delete_file({ target_file: "src/components/Button.jsx" })
```

**28-30 seconds:**
```typescript
read_lints({ paths: ["src/components/Button.tsx"] })
// Verify no errors
```

**Total: ~30 seconds, 8-10 tool calls**

---

## Key Insights

1. **I use grep FIRST** to find where things are
2. **Then read_file** to see the actual code
3. **Then search_replace** to make changes
4. **Then verify** with read_lints

5. **I read multiple files** to understand relationships
6. **I use grep with context** (-B, -A, -C) to see surrounding code
7. **I use replace_all** for global replacements
8. **I verify after each change** to catch errors early

9. **For large files**, I read specific sections (offset/limit)
10. **For multi-file changes**, I do them sequentially but quickly

---

## Tools I Use Most Often

1. **`grep`** - Finding things (80% of searches)
2. **`read_file`** - Reading code (90% of operations)
3. **`search_replace`** - Making changes (70% of edits)
4. **`codebase_search`** - Understanding (20% of searches)
5. **`read_lints`** - Verifying (after every change)

---

## The Magic: Context Awareness

What makes me efficient:

1. **I remember** what I've read
2. **I understand** code relationships
3. **I plan** the full refactor before starting
4. **I verify** as I go

So when you ask "refactor this", I:
- Read the file
- Understand the structure
- Plan all changes needed
- Execute them quickly
- Verify everything works

That's the "30 seconds" - it's not magic, it's **efficient tool usage + context awareness**!

