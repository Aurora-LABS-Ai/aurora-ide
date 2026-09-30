/**
 * The devices the browser panel can show a page as, and where everything goes
 * when it does.
 *
 * Each device is drawn with devices.css (iPhone 14 Pro, Pixel 6 Pro, iPad Pro).
 * The frame geometry below was MEASURED from that library at 1:1 in Chromium
 * (frame size, where the screen sits in it, its corner radius, where the top
 * sensor ends) — not read off its source, which nests borders and paddings.
 *
 * The page is a native window, so it cannot be put INSIDE the frame's DOM. It
 * is placed on top of the frame's screen, starting below a status bar (the
 * Dynamic Island / camera stay visible above the page, as in Safari), and
 * DevTools emulation gives it the device's real CSS width while painting it
 * shrunk by `scale` to fit the panel.
 */

export type DeviceId = "iphone" | "android" | "tablet";

export interface DevicePreset {
  id: DeviceId;
  /** Button label. */
  label: string;
  /** The devices.css class that draws the frame. */
  frameClass: string;
  /** The frame's outer size at 1:1. */
  frame: { width: number; height: number };
  /** The screen inside the frame at 1:1, and its corner radius. */
  screen: { x: number; y: number; width: number; height: number; radius: number };
  /** Height at 1:1 of the status bar under the island / camera. */
  statusBar: number;
  /** The CSS viewport width the page sees. */
  viewportWidth: number;
  deviceScaleFactor: number;
  userAgent: string;
}

export const DEVICE_PRESETS: Record<DeviceId, DevicePreset> = {
  iphone: {
    id: "iphone",
    label: "iPhone",
    frameClass: "device-iphone-14-pro",
    frame: { width: 428, height: 868 },
    screen: { x: 20, y: 20, width: 390, height: 830, radius: 49 },
    // The island ends 44px into the screen; iOS's status bar is 54pt.
    statusBar: 54,
    viewportWidth: 393,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  android: {
    id: "android",
    label: "Android",
    frameClass: "device-google-pixel-6-pro",
    frame: { width: 404, height: 862 },
    screen: { x: 14, y: 20, width: 376, height: 816, radius: 27 },
    // The camera hole ends 30px into the screen.
    statusBar: 40,
    viewportWidth: 412,
    deviceScaleFactor: 3.5,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  },
  tablet: {
    id: "tablet",
    label: "Tablet",
    frameClass: "device-ipad-pro",
    frame: { width: 560, height: 778 },
    // Inside the screen's 2px border.
    screen: { x: 29, y: 29, width: 502, height: 720, radius: 9 },
    statusBar: 24,
    viewportWidth: 834,
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
};

export const DEVICE_ORDER: readonly DeviceId[] = ["iphone", "android", "tablet"];

type Box = { x: number; y: number; width: number; height: number };

export interface DeviceLayout {
  /** How much the frame is shrunk (1 = actual size). */
  frameScale: number;
  /** Where the frame is drawn, relative to the page area. */
  frame: Box;
  /** The status bar strip above the page. */
  statusBar: Box;
  /** Where the native page goes. */
  page: Box;
  /** The page window's bottom corner radius, in the same units. */
  bottomRadius: number;
  /** What DevTools is told: the page's CSS size and its painted scale. */
  emulation: { width: number; height: number; scale: number };
}

/** Breathing room between the frame and the page area's edges. */
const PAD = 16;
/** Never shrink below this: a smaller phone is unreadable, so the frame clips instead. */
const MIN_FRAME_SCALE = 0.25;

/**
 * Fit `preset`'s frame into a `width`×`height` page area, centred, never
 * enlarged past actual size.
 */
export function layoutDevice(preset: DevicePreset, width: number, height: number): DeviceLayout {
  const fit = Math.min(
    (width - PAD * 2) / preset.frame.width,
    (height - PAD * 2) / preset.frame.height,
    1,
  );
  const s = Math.max(MIN_FRAME_SCALE, Number.isFinite(fit) ? fit : MIN_FRAME_SCALE);
  const frame: Box = {
    x: (width - preset.frame.width * s) / 2,
    y: (height - preset.frame.height * s) / 2,
    width: preset.frame.width * s,
    height: preset.frame.height * s,
  };
  const screenX = frame.x + preset.screen.x * s;
  const screenY = frame.y + preset.screen.y * s;
  const statusBar: Box = {
    x: screenX,
    y: screenY,
    width: preset.screen.width * s,
    height: preset.statusBar * s,
  };
  const page: Box = {
    x: screenX,
    y: screenY + preset.statusBar * s,
    width: preset.screen.width * s,
    height: (preset.screen.height - preset.statusBar) * s,
  };
  const scale = page.width / preset.viewportWidth;
  return {
    frameScale: s,
    frame,
    statusBar,
    page,
    bottomRadius: preset.screen.radius * s,
    emulation: {
      width: preset.viewportWidth,
      height: Math.round(page.height / scale),
      scale,
    },
  };
}

/** The payload `browser_set_device` expects. */
export interface DeviceSpec {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
  scale: number;
}

export function deviceSpec(preset: DevicePreset, layout: DeviceLayout): DeviceSpec {
  return {
    width: layout.emulation.width,
    height: layout.emulation.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: true,
    userAgent: preset.userAgent,
    scale: layout.emulation.scale,
  };
}

/** Zoom steps, as in a browser's Ctrl+/Ctrl-. */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** The next zoom step from `zoom` in `direction` (+1 in, -1 out); stays put at the ends. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOM_STEPS[0];
}
