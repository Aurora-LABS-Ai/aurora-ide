/**
 * Agent Window — the icon rail's browser cell [view].
 *
 * Opens the interface in a browser on this computer: starts the web host
 * (`web_host_start`, `src-tauri/src/web_host`) and opens its one-time sign-in
 * link, which leaves the browser holding a cookie. When `aurora serve` is
 * already running, the host hands back that engine's link instead of starting
 * a second server (`external`); that one is stopped in its own terminal. While the host runs, the
 * cell carries the rail's dot and its menu offers the link again, a copy of
 * it, and Stop. Desktop window only: a page that is already in a browser has
 * nothing to open.
 *
 * Drawn with the rail's own button and the project switcher's menu classes;
 * nothing here is styled anew.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openExternalUrl } from "@/apps/agent/adapters/open-external";
import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";
import { writeClipboardText } from "@/kernel/lib/clipboard";
import { auroraInvoke, auroraListen, isDesktopRuntime } from "@/kernel/lib/ipc/runtime";

interface WebHostStatus {
  running: boolean;
  port: number;
  url: string | null;
  signInUrl: string | null;
  /** Served by a separate `aurora serve`, which this window cannot stop. */
  external: boolean;
}

const MENU_WIDTH = 300;

export const WebHostCell: React.FC = () => {
  const [status, setStatus] = useState<WebHostStatus | null>(null);
  const [menu, setMenu] = useState<{ left: number; bottom: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void auroraInvoke<WebHostStatus>("web_host_status")
      .then((found) => !cancelled && setStatus(found))
      .catch((error: unknown) => console.warn("[web-host] status failed", error));
    void auroraListen<WebHostStatus>("web_host_changed", ({ payload }) => setStatus(payload))
      .then((stop) => {
        if (cancelled) stop();
        else off = stop;
      })
      .catch((error: unknown) => console.warn("[web-host] could not follow its state", error));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (triggerRef.current?.contains(target) || target.closest?.(".agw-webhost-menu")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, menu]);

  if (!isDesktopRuntime()) return null;

  const running = status?.running ?? false;
  const external = status?.external ?? false;

  // `aurora serve` may have started or stopped since the last look.
  const refresh = () => {
    void auroraInvoke<WebHostStatus>("web_host_status")
      .then(setStatus)
      .catch((error: unknown) => console.warn("[web-host] status failed", error));
  };

  const startAndOpen = async () => {
    setBusy(true);
    try {
      const started = await auroraInvoke<WebHostStatus>("web_host_start");
      setStatus(started);
      if (started.signInUrl) await openExternalUrl(started.signInUrl);
      close();
    } catch (error) {
      toast(`Could not start the browser host: ${String(error)}`, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!status?.signInUrl) return;
    const copied = await writeClipboardText(status.signInUrl);
    toast(
      copied
        ? "Sign-in link copied. Anyone who opens it can use Aurora on this computer."
        : "Could not copy the link.",
      copied ? undefined : { tone: "error" },
    );
    close();
  };

  const stop = async () => {
    setBusy(true);
    try {
      setStatus(await auroraInvoke<WebHostStatus>("web_host_stop"));
      close();
    } catch (error) {
      toast(`Could not stop the browser host: ${String(error)}`, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const rows: { icon: AgentIconName; label: string; run: () => void }[] = running
    ? [
        { icon: "external", label: "Open in browser", run: () => void startAndOpen() },
        { icon: "copy", label: "Copy sign-in link", run: () => void copyLink() },
        // `aurora serve` is stopped in its own terminal, not from here.
        ...(external ? [] : [{ icon: "stop" as const, label: "Stop", run: () => void stop() }]),
      ]
    : [{ icon: "browser", label: "Start and open in browser", run: () => void startAndOpen() }];

  const note = external
    ? `aurora serve is running at ${status?.url ?? ""}. It is a separate engine, so chats there do not update live in this window yet. Stop it in its terminal.`
    : running
      ? `Running at ${status?.url ?? ""}. Only this computer can reach it.`
      : "Use Aurora from a browser on this computer. Same chats, same agent.";

  const portalTarget =
    typeof document !== "undefined"
      ? ((document.querySelector(".agw-root") as HTMLElement | null) ?? document.body)
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="agw-iconrail-btn"
        data-active={menu ? true : undefined}
        aria-label="Open in a browser"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={running ? `Open in a browser — running at ${status?.url ?? ""}` : "Open in a browser"}
        onClick={() => {
          if (menu) {
            close();
            return;
          }
          refresh();
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setMenu({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom });
        }}
      >
        <AgentIcon name="browser" size={18} solid={menu !== null} />
        {running && <span className="agw-iconrail-dot" title="Running" aria-label="Running" />}
      </button>

      {menu &&
        portalTarget &&
        createPortal(
          <div
            className="agw-projmenu agw-webhost-menu"
            role="menu"
            aria-label="Open in a browser"
            style={{ left: menu.left, bottom: menu.bottom, width: MENU_WIDTH }}
          >
            <div className="agw-projmenu-none">{note}</div>
            {rows.map((row) => (
              <button
                key={row.label}
                type="button"
                role="menuitem"
                className="agw-projmenu-row"
                disabled={busy}
                onClick={row.run}
              >
                <AgentIcon name={row.icon} size={14} />
                <span className="agw-projmenu-name">{row.label}</span>
              </button>
            ))}
          </div>,
          portalTarget,
        )}
    </>
  );
};
