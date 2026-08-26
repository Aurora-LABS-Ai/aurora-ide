/**
 * The IDE surface — everything `/` mounts and `/agent-window` must not.
 *
 * This exists to be a **chunk boundary**. `App.tsx` used to import `MainLayout`
 * and `AgentWindow` statically and call the IDE's hooks before its
 * agent-window early return, so both products shipped in one chunk and the
 * agent window ran the IDE's auto-save, drag-drop listeners, CLI-open watcher
 * and global shortcuts — for an editor it never mounts. Now `App` lazy-loads
 * one surface or the other, and a hook that lives here cannot run in a window
 * that never renders this component.
 *
 * The split is by ownership, not by convenience. Anything that genuinely
 * serves both windows — settings, theme, the agent↔IDE event bridge, the
 * close-time save that also flushes the agent's thread — stays in `App`.
 *
 * Default export: `React.lazy` requires one.
 */

import { useEffect, useState } from "react";

import { MainLayout } from "@/apps/ide/app/MainLayout";
import { DragPreview } from "@/apps/ide/ui/DragPreview";
import { OnboardingModal } from "@/apps/ide/features/settings/OnboardingModal";
import { QuickOpenModal } from "@/apps/ide/features/settings/QuickOpenModal";
import { useAutoSave } from "@/apps/ide/hooks/useAutoSave";
import { useCliOpen } from "@/apps/ide/hooks/useCliOpen";
import { useGlobalShortcuts } from "@/apps/ide/hooks/useGlobalShortcuts";
import { useInternalDrag } from "@/apps/ide/hooks/useInternalDrag";
import { useTauriDragDrop } from "@/apps/ide/hooks/useTauriDragDrop";
import { useWorkspaceBootstrap } from "@/apps/ide/hooks/useWorkspaceBootstrap";
import { handleOpenInIde } from "@/bridge/agent-ide-events";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useEditorStore } from "@/kernel/store/useEditorStore";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";

export default function IdeSurface() {
    const settingsInitialized = useSettingsStore((state) => state.isInitialized);
    const hasSeenOnboarding = useSettingsStore((state) => state.hasSeenOnboarding);
    const restoreWorkspace = useEditorStore((state) => state.restoreWorkspace);
    const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);

    useWorkspaceBootstrap();

    // Initialize auto-save functionality
    useAutoSave();

    // Handle external file drops from OS via Tauri
    useTauriDragDrop();

    // Handle internal drag-drop via mouse events
    useInternalDrag();

    // Handle CLI open requests (aurora . command)
    useCliOpen();

    // Deliberately NOT moved here: `useLocalProviderDetection`. It probes for
    // Ollama / LM Studio and fills the provider list, which the agent window
    // needs as much as the IDE does — and someone who works entirely in the
    // agent window would never mount this component. It stays in `App`.

    // Restore workspace state from database on app startup
    useEffect(() => {
        restoreWorkspace();
    }, [restoreWorkspace]);

    // If the agent window asked to open a file while the IDE was CLOSED, the
    // backend re-created this window and queued the file. Drain it now.
    //
    // The pathname guard this used to carry is gone because it is structural
    // now: only the main window renders this component, so a secondary window
    // cannot reach the queue.
    useEffect(() => {
        let cancelled = false;
        void auroraInvoke<{ path: string; line?: number } | null>("take_pending_ide_open")
            .then((pending) => {
                if (!cancelled && pending?.path) void handleOpenInIde(pending);
            })
            .catch(() => {
                // No pending open / not in the Tauri runtime — nothing to do.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Must be called before any conditional return (React hooks rule).
    useGlobalShortcuts(() => setIsQuickOpenOpen((prev) => !prev));

    // Hold initial render until settings are initialized, preventing
    // first-frame UI flash behind onboarding.
    if (!settingsInitialized) {
        return (
            <div className="h-full w-full bg-editor text-text-primary flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse">
                        <div className="h-3 w-3 rounded-full bg-primary" />
                    </div>
                    <p className="text-xs text-text-secondary uppercase tracking-wider">
                        Initializing Aurora
                    </p>
                </div>
            </div>
        );
    }

    // First-run onboarding is a full-screen takeover. The IDE mounts only after completion.
    if (!hasSeenOnboarding) {
        return <OnboardingModal />;
    }

    return (
        <>
            <MainLayout />
            <DragPreview />
            <QuickOpenModal
                isOpen={isQuickOpenOpen}
                onClose={() => setIsQuickOpenOpen(false)}
            />
        </>
    );
}
