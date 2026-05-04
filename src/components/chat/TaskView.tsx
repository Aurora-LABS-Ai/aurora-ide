/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React from 'react';
import { Check, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { ShimmerText } from '../ui/ShimmerText';

export interface Task {
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

interface TaskViewProps {
    tool: {
        args?: {
            todos?: Task[];
            merge?: boolean;
        };
    };
};

export const CompactTaskList: React.FC<{ todos: Task[] }> = ({ todos }) => {
    const isAllDone = todos.length > 0 && todos.every(t => t.status === 'completed' || t.status === 'cancelled');
    const hasCancelled = todos.some(t => t.status === 'cancelled');
    const inProgress = todos.find(t => t.status === 'in_progress');
    const activeTask = inProgress || todos.slice().reverse().find(t => t.status === 'completed') || todos[0];

    if (todos.length === 0) return null;

    return (
        <div className={clsx(
            "flex items-center justify-center gap-3 text-[10px] py-1 w-full px-4 transition-all duration-500",
            "opacity-100 scale-100 animate-in fade-in"
        )}>
            {isAllDone ? (
                // Completion state - show success message
                <>
                    {hasCancelled ? (
                        <XCircle size={12} className="text-text-disabled" />
                    ) : (
                        <CheckCircle2 size={12} className="text-success" />
                    )}
                    <span className={clsx("font-medium", hasCancelled ? "text-text-disabled" : "text-success")}>
                        {hasCancelled ? "Task list closed" : `All ${todos.length} tasks completed`}
                    </span>
                </>
            ) : (
                // Progress state - show task icons and current task
                <>
                    {/* Sequence Icons */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                        {todos.map((task, i) => {
                            if (task.status === 'completed') {
                                return <Check key={i} size={11} className="text-success" strokeWidth={3} />;
                            }
                            if (task.status === 'in_progress') {
                                return <Loader2 key={i} size={11} className="text-warning animate-spin" strokeWidth={2.5} />;
                            }
                            if (task.status === 'cancelled') {
                                return <XCircle key={i} size={11} className="text-danger" />;
                            }
                            return <div key={i} className="w-1.5 h-1.5 rounded-full bg-border" />;
                        })}
                    </div>

                    {/* Active Label */}
                    {inProgress ? (
                        <ShimmerText className="truncate font-medium max-w-[400px] text-warning">
                            {activeTask?.content || "Tasks initialized..."}
                        </ShimmerText>
                    ) : (
                        <span className="truncate font-medium max-w-[400px] text-text-disabled">
                            {activeTask?.content || "Tasks initialized..."}
                        </span>
                    )}
                </>
            )}
        </div>
    );
};

export const TaskList: React.FC<{ todos: Task[] }> = ({ todos }) => {
    if (todos.length === 0) return null;

    return (
        <div className="mt-2 mb-2 w-full rounded-[14px] overflow-hidden border border-border bg-sidebar shadow-lg shadow-black/20">
            {/* Header */}
            <div className="bg-panel-header px-4 py-2 flex items-center justify-between border-b border-border">
                <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest flex items-center gap-1.5">
                    <Clock size={12} />
                    Task Progress
                </span>
                <span className="text-[10px] text-text-disabled bg-input px-1.5 py-0.5 rounded">
                    {todos.filter(t => t.status === 'completed').length}/{todos.length}
                </span>
            </div>

            {/* Task List */}
            <div className="p-1.5 flex flex-col gap-0.5">
                {todos.map((task, idx) => {
                    const isProgress = task.status === 'in_progress';
                    const isCompleted = task.status === 'completed';
                    const isCancelled = task.status === 'cancelled';

                    return (
                        <div
                            key={task.id || idx}
                            className={clsx(
                                "flex items-start gap-3 px-3 py-2.5 rounded-lg transition-all duration-300",
                                isProgress ? "bg-input/40 border border-border" : "hover:bg-input/20 border border-transparent"
                            )}
                        >
                            <div className="flex-shrink-0 mt-0.5">
                                {isCompleted ? (
                                    <div className="h-4 w-4 rounded-full bg-task-completed/20 flex items-center justify-center ring-1 ring-task-completed/40">
                                        <Check size={10} className="text-task-completed" strokeWidth={3} />
                                    </div>
                                ) : isProgress ? (
                                    <div className="h-4 w-4 relative">
                                        <Loader2 size={16} className="text-task-completed animate-spin" strokeWidth={2.5} />
                                    </div>
                                ) : isCancelled ? (
                                    <XCircle size={16} className="text-task-cancelled/50" />
                                ) : (
                                    <div className="h-4 w-4 rounded-full border border-task-pending/50" />
                                )}
                            </div>

                            <div className="flex-1 min-w-0 flex flex-col">
                                <span className={clsx(
                                    "text-[12px] leading-tight font-medium transition-colors",
                                    isCompleted ? "text-task-completed/80 line-through decoration-task-completed/30" :
                                        isProgress ? "text-text-primary" :
                                            isCancelled ? "text-text-disabled line-through" :
                                                "text-text-disabled"
                                )}>
                                    {task.content}
                                </span>

                                {isProgress && (
                                    <span className="text-[10px] text-task-completed/60 mt-0.5 animate-pulse">
                                        Processing...
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export const TaskView: React.FC<TaskViewProps> = ({ tool }) => {
    const todos = tool.args?.todos || [];
    return <TaskList todos={todos} />;
};
