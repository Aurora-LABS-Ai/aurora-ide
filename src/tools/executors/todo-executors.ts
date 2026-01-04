/**
 * Todo Tool Executors
 * Handles task list management during AI conversations
 */
import { useTaskStore } from "../../store/useTaskStore";
import { toolRegistry } from "../registry";

interface TodoItem {
  activeForm: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoWriteArgs {
  todos: TodoItem[];
}

/**
 * Execute todo_write tool
 * Updates the task store with the new todo list
 */
const executeTodoWrite = async (args: Record<string, unknown>): Promise<string> => {
  const { todos } = args as unknown as TodoWriteArgs;

  if (!todos || !Array.isArray(todos)) {
    return JSON.stringify({
      success: false,
      error: 'Invalid todos array',
    });
  }

  // Validate each todo item
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    if (!todo.content || !todo.status) {
      return JSON.stringify({
        success: false,
        error: `Todo at index ${i} is missing required fields (content, status)`,
      });
    }
    if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
      return JSON.stringify({
        success: false,
        error: `Todo at index ${i} has invalid status: ${todo.status}`,
      });
    }
  }

  // Transform to TaskStore format (add unique IDs)
  const tasks = todos.map((todo, index) => ({
    id: `task_${Date.now()}_${index}`,
    content: todo.activeForm || todo.content, // Use activeForm for display, fallback to content
    status: todo.status,
  }));

  // Update the task store
  const taskStore = useTaskStore.getState();
  taskStore.setTasks(tasks);

  // Calculate summary
  const pending = todos.filter(t => t.status === 'pending').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const completed = todos.filter(t => t.status === 'completed').length;

  console.log('[TodoExecutor] Updated tasks:', { total: todos.length, pending, inProgress, completed });

  return JSON.stringify({
    success: true,
    summary: {
      total: todos.length,
      pending,
      in_progress: inProgress,
      completed,
    },
  });
};

/**
 * Register todo tool executors
 */
export const registerTodoExecutors = (): void => {
  toolRegistry.registerExecutor('todo_write', executeTodoWrite);
  console.log('[TodoExecutors] Todo executors registered');
};

export default {
  registerTodoExecutors,
};
