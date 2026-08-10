import { useEffect } from "react";

export const useGlobalShortcuts = (
    toggleQuickOpen: () => void
) => {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ctrl+P or Cmd+P
            if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
                e.preventDefault(); // Stop browser print dialog
                toggleQuickOpen();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [toggleQuickOpen]);
};
