/**
 * Agent Window — the device drawn around a page shown as a phone or tablet.
 *
 * The frame is devices.css (the library's own markup), shrunk to fit with a
 * transform. The page itself is a native window placed over the frame's screen
 * by `BrowserPanel`, so nothing here draws the page: this is the frame, the
 * dark stage it sits on, and the status bar between the island/camera and the
 * page — the strip a real phone shows its clock in.
 *
 * Positions come from `layoutDevice`, relative to the browser's page area.
 */

import React, { useEffect, useState } from "react";

import type { DeviceLayout, DevicePreset } from "@/apps/agent/lib/browser/devices";
import { statusBarInk } from "@/apps/agent/lib/browser/status-bar";

function clockNow(): string {
  const now = new Date();
  return `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** The phone's clock: minutes are enough, so it ticks every 20s. */
function useClock(): string {
  const [time, setTime] = useState(clockNow);
  useEffect(() => {
    const timer = window.setInterval(() => setTime(clockNow()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  return time;
}

export const DeviceFrame: React.FC<{
  preset: DevicePreset;
  layout: DeviceLayout;
  /** The status bar's colour, taken from the page (`lib/browser/status-bar.ts`). */
  statusColor: string;
  /**
   * How far the panel's open/close glide has pushed the page window right.
   * The page is a native window that cannot be wiped like DOM, so during the
   * glide it is MOVED instead; the frame moves with it, or the page would
   * slide off the phone's screen while the empty frame stayed behind.
   */
  slideX: number;
}> = ({ preset, layout, statusColor, slideX }) => {
  const time = useClock();
  const { frame, statusBar, frameScale } = layout;
  return (
    <div className="agw-devstage" aria-hidden="true">
      <div
        className="agw-devstage-slide"
        style={slideX ? { transform: `translateX(${slideX}px)` } : undefined}
      >
        <div
          className="agw-devframe"
          style={{
            left: frame.x,
            top: frame.y,
            width: preset.frame.width,
            height: preset.frame.height,
            transform: `scale(${frameScale})`,
          }}
        >
          {/* devices.css markup, as its README gives it. */}
          <div className={`device ${preset.frameClass}`}>
            <div className="device-frame">
              <div className="device-screen" />
            </div>
            <div className="device-stripe" />
            <div className="device-header" />
            <div className="device-sensors" />
            <div className="device-btns" />
            <div className="device-power" />
          </div>
        </div>
        {/* Outside `.device` on purpose: devices.css forces display:block on
            everything inside it. The island/camera sit above this strip's
            content, which is kept to the left and right like the real thing. */}
        <div
          className="agw-devstatus"
          data-device={preset.id}
          data-ink={statusBarInk(statusColor)}
          style={{
            background: statusColor,
            left: statusBar.x,
            top: statusBar.y,
            width: statusBar.width,
            height: statusBar.height,
            fontSize: `${Math.max(8, 16 * frameScale)}px`,
            paddingInline: `${Math.max(8, 30 * frameScale)}px`,
            borderTopLeftRadius: preset.screen.radius * frameScale,
            borderTopRightRadius: preset.screen.radius * frameScale,
          }}
        >
          <span className="agw-devstatus-time">{time}</span>
          <span className="agw-devstatus-icons">
            <span className="agw-devstatus-signal" />
            <span className="agw-devstatus-battery" />
          </span>
        </div>
      </div>
    </div>
  );
};
