/**
 * "Export as image": a 1200×640 PNG of the profile's headline facts and the
 * 30-day bars, coloured from the LIVE theme tokens of the element passed in,
 * signed bottom-right with the Aurora mark. Drawn on a canvas so the export
 * never depends on the page's layout.
 */

import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import type { ChartBar } from "./profile-data";

export interface ShareFacts {
  userName: string;
  facts: Array<[value: string, label: string]>;
  bars: ChartBar[];
}

/** Resolves null when the logo can't load; the card still renders without it. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export async function renderShareCard(themedEl: HTMLElement, card: ShareFacts): Promise<Blob> {
  const css = getComputedStyle(themedEl);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 640;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  const bg = token("--agw-canvas", "#111");
  const text = token("--agw-text", "#e6e6e6");
  const subtle = token("--agw-text-subtle", "#727272");
  const accent = token("--agw-accent", "#4b9eff");
  const border = token("--agw-border", "#2a2a2a");
  const font = "Inter, 'Segoe UI', sans-serif";

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1200, 640);
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 1198, 638);

  const logo = await loadImage("/aurora.png");

  ctx.fillStyle = text;
  ctx.font = `600 34px ${font}`;
  ctx.fillText(card.userName, 56, 84);
  ctx.fillStyle = subtle;
  ctx.font = `500 18px ${font}`;
  ctx.fillText(new Date().toLocaleDateString(), 56, 116);

  card.facts.forEach(([value, label], i) => {
    const x = 56 + i * 280;
    ctx.fillStyle = text;
    ctx.font = `650 44px ${font}`;
    ctx.fillText(value, x, 210);
    ctx.fillStyle = subtle;
    ctx.font = `600 14px ${font}`;
    ctx.fillText(label.toUpperCase(), x, 240);
  });

  // The same bars as the page: true heights, every day present.
  const area = { x: 56, y: 290, w: 1088, h: 250 };
  const max = Math.max(1, ...card.bars.map((b) => b.tokens));
  const slot = card.bars.length > 0 ? area.w / card.bars.length : area.w;
  const gap = Math.min(6, slot * 0.25);
  ctx.fillStyle = accent;
  card.bars.forEach((bar, i) => {
    const h = Math.max(bar.tokens > 0 ? 3 : 1, (bar.tokens / max) * (area.h - 30));
    ctx.globalAlpha = bar.tokens > 0 ? 0.85 : 0.25;
    ctx.fillRect(area.x + i * slot + gap / 2, area.y + area.h - h, slot - gap, h);
  });
  ctx.globalAlpha = 1;

  const total = card.bars.reduce((sum, b) => sum + b.tokens, 0);
  ctx.fillStyle = subtle;
  ctx.font = `500 15px ${font}`;
  ctx.fillText(`${formatTokens(total)} tokens in the last 30 days · generated locally`, 56, 600);

  {
    const wordmark = "Aurora Agent";
    ctx.font = `650 21px ${font}`;
    const textW = ctx.measureText(wordmark).width;
    const icon = 32;
    const spacing = 11;
    const baselineY = 604;
    const startX = 1200 - 56 - (icon + spacing + textW);
    ctx.globalAlpha = 0.92;
    if (logo) ctx.drawImage(logo, startX, baselineY - icon + 7, icon, icon);
    ctx.fillStyle = text;
    ctx.fillText(wordmark, startX + icon + spacing, baselineY);
    ctx.globalAlpha = 1;
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}
