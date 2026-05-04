import { create } from "zustand";

interface TaskState {
    clearTasks: () => void;
    finalizeActiveTasks: (outcome: "completed" | "cancelled") => void;
    isAllComplete: boolean; // Track if all tasks just completed (for fade-out animation)
    isVisible: boolean;
    setIsVisible: (visible: boolean) => void;

    // Actions
    setTasks: (tasks: Task[]) => void;
    tasks: Task[];
    updateTask: (id: string, status: Task['status']) => void;
}

export interface Task {
    activeForm?: string; // Present continuous form for display during progress
    content: string; // Display text (uses activeForm when available)
    id: string;
    originalContent?: string; // Original imperative form
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

// Timer for auto-hide
let autoHideTimer: ReturnType<typeof setTimeout> | null = null;

const clearAutoHideTimer = () => {
    if (autoHideTimer) {
        clearTimeout(autoHideTimer);
        autoHideTimer = null;
    }
};

const scheduleAutoHide = (set: (state: Partial<TaskState>) => void) => {
    clearAutoHideTimer();
    autoHideTimer = setTimeout(() => {
        set({ tasks: [], isVisible: false, isAllComplete: false });
        autoHideTimer = null;
    }, 2500);
};

const areAllTasksTerminal = (tasks: Task[]) =>
    tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'cancelled');

export const useTaskStore = create<TaskState>((set) => ({
    tasks: [],
    isVisible: false,
    isAllComplete: false,

    setTasks: (tasks) => {
        clearAutoHideTimer();

        const allComplete = areAllTasksTerminal(tasks);

        set({
            tasks,
            isVisible: tasks.length > 0,
            isAllComplete: allComplete,
        });

        // Auto-hide after terminal task states so the UI cannot remain stuck.
        if (allComplete) {
            scheduleAutoHide(set);
        }
    },

    updateTask: (id, status) => set((state) => ({
        tasks: state.tasks.map(t => t.id === id ? { ...t, status } : t)
    })),

    setIsVisible: (isVisible) => set({ isVisible }),

    finalizeActiveTasks: (outcome) => {
        set((state) => {
            if (state.tasks.length === 0 || areAllTasksTerminal(state.tasks)) {
                return state;
            }

            const tasks = state.tasks.map((task) => {
                if (task.status === 'completed' || task.status === 'cancelled') {
                    return task;
                }

                return {
                    ...task,
                    status: outcome,
                };
            });

            scheduleAutoHide(set);

            return {
                tasks,
                isVisible: true,
                isAllComplete: true,
            };
        });
    },

    clearTasks: () => {
        clearAutoHideTimer();
        set({ tasks: [], isVisible: false, isAllComplete: false });
    },
}));

// DEBUG: Expose to window for console testing
if (typeof window !== 'undefined') {
    window.taskStore = useTaskStore;
}

declare global {
    interface Window {
        taskStore?: typeof useTaskStore;
    }
}
