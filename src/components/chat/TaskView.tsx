import React, { useState, useEffect } from 'react';
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
    const [isFadingOut, setIsFadingOut] = useState(false);

    const isAllDone = todos.length > 0 && todos.every(t => t.status === 'completed');
    const inProgress = todos.find(t => t.status === 'in_progress');
    const activeTask = inProgress || todos.slice().reverse().find(t => t.status === 'completed') || todos[0];

    // Start fade-out animation when all tasks complete
    useEffect(() => {
        if (isAllDone) {
            // Start fade after showing completion for 1.5s
            const timer = setTimeout(() => {
                setIsFadingOut(true);
            }, 1500);
            return () => clearTimeout(timer);
        } else {
            setIsFadingOut(false);
        }
    }, [isAllDone]);

    if (todos.length === 0) return null;

    return (
        <div className={clsx(
            "flex items-center justify-center gap-3 text-[10px] py-1 w-full px-4 transition-all duration-500",
            isFadingOut ? "opacity-0 scale-95" : "opacity-100 scale-100 animate-in fade-in"
        )}>
            {isAllDone ? (
                // Completion state - show success message
                <>
                    <CheckCircle2 size={12} className="text-emerald-400" />
                    <span className="text-emerald-400 font-medium">
                        All {todos.length} tasks completed
                    </span>
                </>
            ) : (
                // Progress state - show task icons and current task
                <>
                    {/* Sequence Icons */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                        {todos.map((task, i) => {
                            if (task.status === 'completed') {
                                return <Check key={i} size={11} className="text-emerald-400" strokeWidth={3} />;
                            }
                            if (task.status === 'in_progress') {
                                return <Loader2 key={i} size={11} className="text-amber-400 animate-spin" strokeWidth={2.5} />;
                            }
                            if (task.status === 'cancelled') {
                                return <XCircle key={i} size={11} className="text-red-400" />;
                            }
                            return <div key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-700" />;
                        })}
                    </div>

                    {/* Active Label */}
                    {inProgress ? (
                        <ShimmerText className="truncate font-medium max-w-[400px] text-amber-400">
                            {activeTask?.content || "Tasks initialized..."}
                        </ShimmerText>
                    ) : (
                        <span className="truncate font-medium max-w-[400px] text-zinc-500">
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
        <div className="mt-2 mb-2 w-full rounded-[14px] overflow-hidden border border-white/5 bg-[#121212]/80 shadow-lg shadow-black/20">
            {/* Header */}
            <div className="bg-white/5 px-4 py-2 flex items-center justify-between border-b border-white/5">
                <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-widest flex items-center gap-1.5">
                    <Clock size={12} />
                    Task Progress
                </span>
                <span className="text-[10px] text-zinc-600 bg-black/20 px-1.5 py-0.5 rounded">
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
                                isProgress ? "bg-white/[0.03] border border-white/5" : "hover:bg-white/[0.01] border border-transparent"
                            )}
                        >
                            <div className="flex-shrink-0 mt-0.5">
                                {isCompleted ? (
                                    <div className="h-4 w-4 rounded-full bg-emerald-500/20 flex items-center justify-center ring-1 ring-emerald-500/40">
                                        <Check size={10} className="text-emerald-400" strokeWidth={3} />
                                    </div>
                                ) : isProgress ? (
                                    <div className="h-4 w-4 relative">
                                        <Loader2 size={16} className="text-emerald-400 animate-spin" strokeWidth={2.5} />
                                    </div>
                                ) : isCancelled ? (
                                    <XCircle size={16} className="text-red-400/50" />
                                ) : (
                                    <div className="h-4 w-4 rounded-full border border-zinc-700/50" />
                                )}
                            </div>

                            <div className="flex-1 min-w-0 flex flex-col">
                                <span className={clsx(
                                    "text-[12px] leading-tight font-medium transition-colors",
                                    isCompleted ? "text-emerald-400/80 line-through decoration-emerald-500/30" :
                                        isProgress ? "text-zinc-100" :
                                            isCancelled ? "text-zinc-600 line-through" :
                                                "text-zinc-500"
                                )}>
                                    {task.content}
                                </span>

                                {isProgress && (
                                    <span className="text-[10px] text-emerald-500/60 mt-0.5 animate-pulse">
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
