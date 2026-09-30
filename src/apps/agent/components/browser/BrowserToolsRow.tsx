/**
 * Agent Window — the browser's tools row.
 *
 * Opened from the toolbar's tools button, it sits UNDER the toolbar and pushes
 * the page down instead of dropping over it: the page is a native window that
 * paints above any DOM, so a menu over it would force the page to hide, and
 * every device or zoom change would be made blind (probe:
 * Documents/aurora-browser-menu-designs.html, 03).
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgwSegmented } from "@/apps/agent/settings/primitives";
import { DEVICE_ORDER, DEVICE_PRESETS, type DeviceId } from "@/apps/agent/lib/browser/devices";

type DeviceChoice = DeviceId | "default";

const DEVICE_OPTIONS: { value: DeviceChoice; label: string }[] = [
  { value: "default", label: "Default" },
  ...DEVICE_ORDER.map((id) => ({ value: id as DeviceChoice, label: DEVICE_PRESETS[id].label })),
];

export const BrowserToolsRow: React.FC<{
  device: DeviceId | undefined;
  onDevice: (device: DeviceId | undefined) => void;
  zoom: number;
  onZoomStep: (direction: 1 | -1) => void;
  onZoomReset: () => void;
  findOpen: boolean;
  onToggleFind: () => void;
  onScreenshot: () => void;
  capturing: boolean;
  /** A short line after an action — "Screenshot added to your message". */
  notice: { text: string; tone: "ok" | "error" } | null;
}> = ({
  device,
  onDevice,
  zoom,
  onZoomStep,
  onZoomReset,
  findOpen,
  onToggleFind,
  onScreenshot,
  capturing,
  notice,
}) => {
  // A device sets the page's size, so zoom would change the device's width.
  const zoomLocked = !!device;
  const zoomTitle = zoomLocked ? "Zoom is off while showing a device — the device sets the size" : undefined;
  const percent = `${Math.round((zoomLocked ? 1 : zoom) * 100)}%`;

  return (
    <div className="agw-br-tools" role="toolbar" aria-label="Browser tools">
      <AgwSegmented<DeviceChoice>
        value={device ?? "default"}
        options={DEVICE_OPTIONS}
        onChange={(next) => onDevice(next === "default" ? undefined : next)}
        ariaLabel="Show the page as"
      />
      {notice ? (
        <span className="agw-br-tools-notice" data-tone={notice.tone} role="status">
          {notice.text}
        </span>
      ) : (
        <span className="agw-br-tools-spacer" />
      )}
      <div className="agw-br-zoom" title={zoomTitle}>
        <button
          type="button"
          className="agw-br-nav"
          aria-label="Zoom out"
          title={zoomTitle ?? "Zoom out"}
          disabled={zoomLocked}
          onClick={() => onZoomStep(-1)}
        >
          <AgentIcon name="zoom-out" size={14} />
        </button>
        <button
          type="button"
          className="agw-br-zoom-val"
          aria-label={`Zoom ${percent}, reset to 100%`}
          title={zoomTitle ?? "Reset to 100%"}
          disabled={zoomLocked || zoom === 1}
          onClick={onZoomReset}
        >
          {percent}
        </button>
        <button
          type="button"
          className="agw-br-nav"
          aria-label="Zoom in"
          title={zoomTitle ?? "Zoom in"}
          disabled={zoomLocked}
          onClick={() => onZoomStep(1)}
        >
          <AgentIcon name="zoom-in" size={14} />
        </button>
      </div>
      <span className="agw-br-tools-sep" aria-hidden="true" />
      <button
        type="button"
        className="agw-br-nav"
        aria-label="Find in page"
        aria-pressed={findOpen}
        title="Find in page (Ctrl+F)"
        data-on={findOpen || undefined}
        onClick={onToggleFind}
      >
        <AgentIcon name="search" size={14} />
      </button>
      <button
        type="button"
        className="agw-br-nav"
        aria-label="Screenshot to your message"
        title="Screenshot to your message"
        disabled={capturing}
        onClick={onScreenshot}
      >
        <AgentIcon name="browser-screenshot" size={15} />
      </button>
    </div>
  );
};
