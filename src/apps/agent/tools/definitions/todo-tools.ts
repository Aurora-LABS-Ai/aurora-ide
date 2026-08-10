/**
 * Todo Tool Definitions
 * Tools for managing task lists during AI conversations
 *
 * NOT what the agent sees. The Agent Window's model is advertised the Rust
 * registry's `todo` tool (one tool, `op: set | update | read`); this definition
 * is `nativeRustOwned`, so `AgentService.buildAvailableTools` strips it before
 * the request is built and it can never reach a model as a rival `todo_write`.
 * It survives only for the legacy IDE chat path, which still renders a proposed
 * list from a `todo_write` call inline (`ToolItem` / `useChatStore`).
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

export const todoTools: ToolDefinition[] = [
  {
    type: 'function',
    nativeRustOwned: true,
    function: {
      name: 'todo_write',
      description: `Create or update a task list to track progress on multi-step tasks.

IMPORTANT RULES:
1. Use this tool for complex tasks that require 3+ steps
2. Always include BOTH 'content' (imperative form) and 'activeForm' (present continuous) for each task
3. Mark tasks as 'in_progress' BEFORE starting work on them
4. Mark tasks as 'completed' IMMEDIATELY after finishing each task
5. Only ONE task should be 'in_progress' at a time
6. If you create tasks but never update their status, they will appear stuck forever

Examples of correct task structure:
- content: "Run the build", activeForm: "Running the build"
- content: "Fix type errors", activeForm: "Fixing type errors"
- content: "Create user component", activeForm: "Creating user component"`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete updated todo list. Each call replaces the previous list.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'The task description in imperative form (e.g., "Fix the bug", "Add tests")',
                },
                activeForm: {
                  type: 'string',
                  description: 'The task description in present continuous form (e.g., "Fixing the bug", "Adding tests")',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Task status: pending (not started), in_progress (currently working), completed (finished)',
                },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

export default todoTools;
