/**
 * Agent Window — external (OS) file drop onto the composer.
 *
 * In a Tauri webview, files dragged from the OS file manager (Windows Explorer,
 * Finder) do NOT arrive through the browser's HTML5 `drop`/`dataTransfer` — the
 * native window layer intercepts them and Tauri re-emits them as events carrying
 * absolute paths. This hook subscribes to those, hit-tests the drop position
 * against the composer element, and hands the paths to the caller (which
 * classifies them into image attachments vs. `@path` file mentions).
 *
 * SUBSCRIPTION TARGET — must be `{kind: 'WebviewWindow', label}`. Do not
 * "simplify" this to `getCurrentWindow().onDragDropEvent(...)` (Window kind)
 * or to a string target (AnyLabel kind). Both were tried; both are silently
 * never called.
 *
 * On Windows the OS drag lands on the WEBVIEW, so Tauri emits these events
 * from `manager/webview.rs::on_webview_event` → `emit_to_webview`, whose
 * delivery filter is a hard match on the listener's registered kind:
 * `Webview{label} | WebviewWindow{label} => label == window_label, _ => false`.
 * A `Window`-kind or `AnyLabel`-kind listener is in that `_ => false` arm and
 * is never fed, no matter the label. (`{kind:'Any'}` bypasses the filter in
 * `event/listener.rs::match_any_or_filter` — that's how the events were proved
 * to arrive — but it would also pick up drops onto the IDE window and insert
 * their files into this composer, so it is not the fix.)
 *
 * Runtime-verified on Windows (tauri 2.9.5): with all four kinds registered at
 * once, an Explorer drop fired ONLY the `WebviewWindow`-kind and `Any`-kind
 * listeners; `Window` and `AnyLabel` stayed silent.
 *
 * WHAT COUNTS AS A DROP: dropping ON the composer is exact, but requiring it is
 * a trap — the composer is a small box in a large window, so a near miss reads
 * as "the feature is broken" rather than "you missed". So a drop anywhere in the
 * window that isn't over some OTHER composer is claimed by the primary one, and
 * the composer highlights for the whole drag rather than only over its own
 * rectangle. With several composers on screen (a docked chat), the one under the
 * pointer wins; when the pointer is over none of them, the first in document
 * order takes it. Every instance evaluates that identically, so no coordination
 * is needed and exactly one accepts.
 *
 * The reported position is in PHYSICAL pixels; we divide by `devicePixelRatio`
 * to compare against CSS-pixel bounding rects. The `drop` payload is not trusted
 * to carry one: when it doesn't, the last `over` position is used, because a drop
 * whose coordinates we can't establish would otherwise be discarded in silence —
 * the exact shape of "I dropped a file and nothing happened".
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { PATH_DROP_ZONE_ATTR } from "@/apps/agent/lib/path-drag";

interface DragDropPayload {
  paths?: string[];
  position?: { x: number; y: number };
}

export function useAgentExternalDrop(
  targetRef: RefObject<HTMLElement | null>,
  onPaths: (paths: string[]) => void,
): boolean {
  const [isDragOver, setIsDragOver] = useState(false);
  // Keep the latest callback without resubscribing the (async) listeners.
  const onPathsRef = useRef(onPaths);
  useEffect(() => {
    onPathsRef.current = onPaths;
  }, [onPaths]);

  // Last position seen while dragging over the window, in physical pixels.
  const lastOverRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const offs: Array<() => void> = [];
    let disposed = false;

    /** Does THIS composer own a drag at this physical-pixel point? */
    const claims = (x: number, y: number): boolean => {
      const el = targetRef.current;
      if (!el) return false;
      const dpr = window.devicePixelRatio || 1;
      const px = x / dpr;
      const py = y / dpr;
      const covers = (node: Element) => {
        const r = node.getBoundingClientRect();
        return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
      };
      if (covers(el)) return true;
      // Over a DIFFERENT composer → that one owns it, not us.
      const zones = Array.from(
        document.querySelectorAll<HTMLElement>(`[${PATH_DROP_ZONE_ATTR}]`),
      );
      if (zones.some(covers)) return false;
      // Over none of them: the first in document order takes it.
      return zones.length === 0 || zones[0] === el;
    };

    const track = (p: DragDropPayload) => {
      if (!p.position) return;
      lastOverRef.current = p.position;
      setIsDragOver(claims(p.position.x, p.position.y));
    };

    void (async () => {
      try {
        const [{ getCurrentWindow }, { listen, TauriEvent }] = await Promise.all([
          import("@tauri-apps/api/window"),
          import("@tauri-apps/api/event"),
        ]);
        // The ONLY kind `emit_to_webview` feeds (with `Webview`). See above.
        const target = {
          kind: "WebviewWindow",
          label: getCurrentWindow().label,
        } as const;

        const sub = async (
          event: string,
          handler: (payload: DragDropPayload) => void,
        ) => {
          const off = await listen<DragDropPayload>(
            event,
            (e) => handler(e.payload ?? {}),
            { target },
          );
          if (disposed) off();
          else offs.push(off);
        };

        await sub(TauriEvent.DRAG_ENTER, track);
        await sub(TauriEvent.DRAG_OVER, track);
        await sub(TauriEvent.DRAG_DROP, (p) => {
          const pos = p.position ?? lastOverRef.current;
          // No position at all (payload empty AND no `over` seen) still lands:
          // the file was dropped on this window, and refusing it because we
          // can't say where is the failure mode this whole path is guarding.
          const hit = pos ? claims(pos.x, pos.y) : true;
          setIsDragOver(false);
          lastOverRef.current = null;
          if (!hit || !Array.isArray(p.paths) || p.paths.length === 0) return;
          try {
            onPathsRef.current(p.paths);
          } catch (err) {
            console.error("[agent-window] OS drop handler failed:", err);
          }
        });
        await sub(TauriEvent.DRAG_LEAVE, () => {
          lastOverRef.current = null;
          setIsDragOver(false);
        });
      } catch (err) {
        console.warn("[agent-window] external drop listener failed:", err);
      }
    })();

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [targetRef]);

  return isDragOver;
}
