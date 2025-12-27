import { useEffect, useState } from "react";
import { MainLayout } from "./components/layout/MainLayout";
import { DetachedChatWindow } from "./components/chat/DetachedChatWindow";
import { useUiStore } from "./store/useUiStore";
import { useWorkspaceBootstrap } from "./hooks/useWorkspaceBootstrap";
import { useEditorStore } from "./store/useEditorStore";
import { useAutoSave } from "./hooks/useAutoSave";
import { useTauriDragDrop } from "./hooks/useTauriDragDrop";
import { useInternalDrag } from "./hooks/useInternalDrag";
import { DragPreview } from "./components/ui/DragPreview";

function App() {
  const { theme } = useUiStore();
  const [isDetachedWindow, setIsDetachedWindow] = useState(false);
  const restoreWorkspace = useEditorStore((state) => state.restoreWorkspace);
  useWorkspaceBootstrap();
  
  // Initialize auto-save functionality
  useAutoSave();

  // Handle external file drops from OS via Tauri
  useTauriDragDrop();

  // Handle internal drag-drop via mouse events
  useInternalDrag();

  useEffect(() => {
    // Check if this is the detached chat window based on URL path
    const path = window.location.pathname;
    setIsDetachedWindow(path === "/chat-detached");
  }, []);

  // Restore workspace state from database on app startup
  useEffect(() => {
    if (!isDetachedWindow) {
      restoreWorkspace();
    }
  }, [isDetachedWindow, restoreWorkspace]);

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [theme]);

  // Disable default context menu globally
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Allow context menu in input/textarea elements
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }
      e.preventDefault();
    };

    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // Render detached chat window if on that route
  if (isDetachedWindow) {
    return <DetachedChatWindow />;
  }

  return (
    <>
      <MainLayout />
      <DragPreview />
    </>
  );
}

export default App;
