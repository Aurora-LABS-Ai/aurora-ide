/**
 * Agent Window — `<aurora_image>` marker helpers.
 *
 * Images are transported to the model by embedding them in the user message as
 * `<aurora_image media_type="...">BASE64</aurora_image>` markers — the exact
 * format the Rust provider adapter already splits into real `image` /
 * `image_url` content blocks (vision-gated). Keeping the format identical means
 * user-pasted images reuse the same tested wire path as `browser_screenshot`.
 *
 * These helpers build markers for sending and parse/strip them for display
 * (the user bubble renders the images and shows only the human-typed text).
 */

import type { ImageAttachment } from "../store/useAgentAttachmentStore";

/** Build the marker string for a single attachment. */
export function buildImageMarker(a: { mediaType: string; base64: string }): string {
  return `<aurora_image media_type="${a.mediaType}">${a.base64}</aurora_image>`;
}

/**
 * Append image markers to a user message. The typed text stays first (so titles
 * / previews read cleanly) with the markers as a trailing block.
 */
export function appendImageMarkers(text: string, images: ImageAttachment[]): string {
  if (images.length === 0) return text;
  const markers = images.map(buildImageMarker).join("\n");
  return text ? `${text}\n\n${markers}` : markers;
}

export interface ParsedImage {
  mediaType: string;
  base64: string;
}

export interface ParsedUserContent {
  /** The message text with all image markers removed. */
  text: string;
  /** Images extracted from the markers, in order. */
  images: ParsedImage[];
}

const MARKER_RE = /<aurora_image\s+media_type="([^"]+)"\s*>([\s\S]*?)<\/aurora_image>/g;

/** Split a user message into its visible text and any embedded images. */
export function parseUserContent(content: string): ParsedUserContent {
  const images: ParsedImage[] = [];
  let text = content.replace(MARKER_RE, (_full, mediaType: string, base64: string) => {
    const data = base64.trim();
    if (data) images.push({ mediaType, base64: data });
    return "";
  });
  // Collapse the blank lines left where markers used to be.
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text, images };
}

/** True when the content carries at least one image marker. */
export function hasImageMarker(content: string): boolean {
  return content.includes("<aurora_image ");
}
