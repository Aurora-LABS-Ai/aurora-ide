import { create } from 'zustand';

export interface Task {
    id: string;
    content: string;        // Display text (uses activeForm when available)
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    activeForm?: string;    // Present continuous form for display during progress
    originalContent?: string; // Original imperative form
}

interface TaskState {
    tasks: Task[];
    isVisible: boolean;
    isAllComplete: boolean; // Track if all tasks just completed (for fade-out animation)

    // Actions
    setTasks: (tasks: Task[]) => void;
    updateTask: (id: string, status: Task['status']) => void;
    setIsVisible: (visible: boolean) => void;
    clearTasks: () => void;
}

// Timer for auto-hide
let autoHideTimer: ReturnType<typeof setTimeout> | null = null;

export const useTaskStore = create<TaskState>((set, _get) => ({
    tasks: [],
    isVisible: false,
    isAllComplete: false,

    setTasks: (tasks) => {
        // Clear any existing auto-hide timer
        if (autoHideTimer) {
            clearTimeout(autoHideTimer);
            autoHideTimer = null;
        }

        const allComplete = tasks.length > 0 && tasks.every(t => t.status === 'completed');

        set({
            tasks,
            isVisible: tasks.length > 0,
            isAllComplete: allComplete,
        });

        // Auto-hide after 2.5 seconds if all tasks are complete
        if (allComplete) {
            autoHideTimer = setTimeout(() => {
                set({ isVisible: false, tasks: [], isAllComplete: false });
                autoHideTimer = null;
            }, 2500);
        }
    },

    updateTask: (id, status) => set((state) => ({
        tasks: state.tasks.map(t => t.id === id ? { ...t, status } : t)
    })),

    setIsVisible: (isVisible) => set({ isVisible }),

    clearTasks: () => {
        if (autoHideTimer) {
            clearTimeout(autoHideTimer);
            autoHideTimer = null;
        }
        set({ tasks: [], isVisible: false, isAllComplete: false });
    },
}));

// DEBUG: Expose to window for console testing
if (typeof window !== 'undefined') {
    (window as any).taskStore = useTaskStore;
}
