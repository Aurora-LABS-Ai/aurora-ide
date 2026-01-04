import { useCallback, useEffect, useRef } from "react";

import { useUiStore } from "../store/useUiStore";

interface DetachedWindowConfig {
  alwaysOnTop?: boolean;
  height?: number;
  width?: number;
  x?: number;
  y?: number;
}

export function useDetachedChatWindow() {
  const {
    detachedChat,
    detachChat,
    reattachChat,
    updateDetachedPosition,
    updateDetachedSize,
  } = useUiStore();

  const windowRef = useRef<any>(null);
  const isCreatingRef = useRef(false);
  const mainWindowCloseListenerRef = useRef<(() => void) | null>(null);

  const createDetachedWindow = useCallback(
    async (config: DetachedWindowConfig = {}) => {
      if (isCreatingRef.current || detachedChat.isDetached) {
        return;
      }

      isCreatingRef.current = true;

      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");

        // Get main window position to place chat window nearby
        const mainWindow = getCurrentWindow();
        const mainPosition = await mainWindow.outerPosition();
        const mainSize = await mainWindow.outerSize();

        const windowWidth = config.width || 420;
        const windowHeight = config.height || Math.min(mainSize.height, 700);

        // Position to the right of the main window, but ensure it stays on screen
        // Calculate center position relative to main window
        let windowX: number;
        let windowY: number;

        if (config.x !== undefined) {
          windowX = config.x;
        } else {
          // Position slightly to the right of main window center
          windowX = mainPosition.x + Math.floor((mainSize.width - windowWidth) / 2) + 50;
          // Ensure it doesn't go negative or too far right
          windowX = Math.max(50, Math.min(windowX, mainPosition.x + mainSize.width - 100));
        }

        if (config.y !== undefined) {
          windowY = config.y;
        } else {
          // Center vertically with the main window
          windowY = mainPosition.y + Math.floor((mainSize.height - windowHeight) / 2);
          // Ensure it doesn't go negative
          windowY = Math.max(50, windowY);
        }

        // Create the detached chat window
        const chatWindow = new WebviewWindow(CHAT_WINDOW_LABEL, {
          url: CHAT_WINDOW_URL,
          title: "Aurora Chat",
          width: windowWidth,
          height: windowHeight,
          x: windowX,
          y: windowY,
          decorations: false,
          resizable: true,
          alwaysOnTop: config.alwaysOnTop ?? false,
          focus: true,
          transparent: false,
          minWidth: 320,
          minHeight: 400,
        });

        windowRef.current = chatWindow;

        // Listen for window close event
        chatWindow.once("tauri://destroyed", () => {
          windowRef.current = null;
          reattachChat();
        });

        // Listen for main window close to close detached window too
        mainWindowCloseListenerRef.current = (await mainWindow.onCloseRequested(
          async () => {
            // Close the detached chat window when main window closes
            if (windowRef.current) {
              try {
                await windowRef.current.close();
              } catch (e) {
                // Window might already be closed
              }
            }
          },
        )) as unknown as () => void;

        // Listen for window move/resize to save position
        // Note: These listeners are automatically cleaned up when the window is destroyed
        chatWindow.listen("tauri://move", async () => {
          try {
            const pos = await chatWindow.outerPosition();
            updateDetachedPosition({ x: pos.x, y: pos.y });
          } catch {
            // Window might be closing, ignore errors
          }
        }).catch(() => {});

        chatWindow.listen("tauri://resize", async () => {
          try {
            const size = await chatWindow.outerSize();
            updateDetachedSize({ width: size.width, height: size.height });
          } catch {
            // Window might be closing, ignore errors
          }
        }).catch(() => {});

        // Update store
        detachChat(CHAT_WINDOW_LABEL);
      } catch (error) {
        console.error("Failed to create detached chat window:", error);
      } finally {
        isCreatingRef.current = false;
      }
    },
    [
      detachedChat.isDetached,
      detachChat,
      reattachChat,
      updateDetachedPosition,
      updateDetachedSize,
    ],
  );

  const closeDetachedWindow = useCallback(async () => {
    if (!detachedChat.isDetached) {
      return;
    }

    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const chatWindow = await WebviewWindow.getByLabel(CHAT_WINDOW_LABEL);

      if (chatWindow) {
        await chatWindow.close();
      }

      windowRef.current = null;
      reattachChat();
    } catch (error) {
      console.error("Failed to close detached chat window:", error);
      reattachChat();
    }
  }, [detachedChat.isDetached, reattachChat]);

  const focusDetachedWindow = useCallback(async () => {
    if (!detachedChat.isDetached) {
      return;
    }

    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const chatWindow = await WebviewWindow.getByLabel(CHAT_WINDOW_LABEL);

      if (chatWindow) {
        await chatWindow.setFocus();
      }
    } catch (error) {
      console.error("Failed to focus detached chat window:", error);
    }
  }, [detachedChat.isDetached]);

  const toggleAlwaysOnTop = useCallback(
    async (alwaysOnTop: boolean) => {
      if (!detachedChat.isDetached) {
        return;
      }

      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const chatWindow = await WebviewWindow.getByLabel(CHAT_WINDOW_LABEL);

        if (chatWindow) {
          await chatWindow.setAlwaysOnTop(alwaysOnTop);
        }
      } catch (error) {
        console.error("Failed to toggle always on top:", error);
      }
    },
    [detachedChat.isDetached],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Don't call closeDetachedWindow on unmount - it causes issues
      // The window will be closed naturally when the app closes
      
      // Safely cleanup main window close listener
      const listener = mainWindowCloseListenerRef.current;
      mainWindowCloseListenerRef.current = null;
      
      if (listener) {
        // Use setTimeout to defer the unlisten call, avoiding race conditions
        // where the handler might already be destroyed
        setTimeout(() => {
          try {
            listener();
          } catch (e) {
            // Handler may already be destroyed - this is expected
            console.debug('[useDetachedChatWindow] Cleanup listener already destroyed');
          }
        }, 0);
      }
    };
  }, []); // Remove closeDetachedWindow dependency to prevent re-running

  return {
    isDetached: detachedChat.isDetached,
    windowLabel: detachedChat.windowLabel,
    position: detachedChat.position,
    size: detachedChat.size,
    createDetachedWindow,
    closeDetachedWindow,
    focusDetachedWindow,
    toggleAlwaysOnTop,
  };
}

const CHAT_WINDOW_LABEL = "chat-detached";
const CHAT_WINDOW_URL = "/chat-detached";
