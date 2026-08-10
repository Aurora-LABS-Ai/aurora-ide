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

import type { ImageAttachment } from "@/apps/agent/store/composer/useAgentAttachmentStore";

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

const OPEN = "<aurora_image ";
export const MARKER_CLOSE = "</aurora_image>";

/** A structurally valid marker located inside a larger string. */
export interface ImageMarker {
  /** Index of the opening `<`. */
  start: number;
  /** Index just past the header's closing `>` (= start of the body). */
  headerEnd: number;
  /** Index just past `</aurora_image>`. */
  end: number;
  /** Raw body — valid base64, or blank for a lean marker rehydrated from `src`. */
  body: string;
  attrs: Record<string, string>;
}

/**
 * Standard-alphabet base64 check: correct alphabet, length a multiple of 4,
 * padding only in the final quantum. Rejects embedded whitespace — neither
 * emitter wraps its output.
 */
function isBase64Payload(s: string): boolean {
  return s.length >= 4 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Parse a header into `name="value"` pairs, or null if it holds anything else. */
function parseAttrs(header: string): Record<string, string> | null {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w-]*)="([^"]*)"/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    // Anything between the previous pair and this one must be whitespace —
    // otherwise it's prose, not a header.
    if (header.slice(consumed, m.index).trim() !== "") return null;
    attrs[m[1]] = m[2];
    consumed = m.index + m[0].length;
  }
  if (header.slice(consumed).trim() !== "") return null;
  return Object.keys(attrs).length > 0 ? attrs : null;
}

/**
 * Find the first structurally valid marker at or after `from`.
 *
 * Mirrors `src-tauri/src/api/aurora_image.rs` — keep the two in step. A bare
 * `indexOf("<aurora_image ")` fires on any text that *quotes* the marker syntax
 * (this project's own docs and source do), which is how a plain file read once
 * rendered as a screenshot card and shipped prose to the provider as base64.
 */
export function findImageMarker(content: string, from = 0): ImageMarker | null {
  let search = Math.max(0, from);
  for (;;) {
    const start = content.indexOf(OPEN, search);
    if (start < 0) return null;

    const marker = parseMarkerAt(content, start);
    if (marker) return marker;
    search = start + OPEN.length;
  }
}

function parseMarkerAt(content: string, start: number): ImageMarker | null {
  const attrsStart = start + OPEN.length;
  const gt = content.indexOf(">", attrsStart);
  if (gt < 0) return null;

  const header = content.slice(attrsStart, gt);
  // The header is single-line and holds no nested tag. Bailing here is what
  // stops a paragraph of prose being read as a header running to some unrelated
  // `>` further down the page.
  if (/[<\n\r]/.test(header)) return null;

  const attrs = parseAttrs(header);
  if (!attrs) return null;
  const mediaType = attrs.media_type;
  if (!mediaType || !mediaType.startsWith("image/") || mediaType === "image/") return null;

  const headerEnd = gt + 1;
  const bodyEnd = content.indexOf(MARKER_CLOSE, headerEnd);
  if (bodyEnd < 0) return null;

  const body = content.slice(headerEnd, bodyEnd);
  const trimmed = body.trim();
  // Empty body = lean marker (bytes stripped for persistence, re-read from
  // `src`). Anything else must actually be base64.
  if (trimmed !== "" && !isBase64Payload(trimmed)) return null;

  return { start, headerEnd, end: bodyEnd + MARKER_CLOSE.length, body, attrs };
}

/** Every structurally valid marker in `content`, in order. */
export function findImageMarkers(content: string): ImageMarker[] {
  const out: ImageMarker[] = [];
  let cursor = 0;
  for (;;) {
    const marker = findImageMarker(content, cursor);
    if (!marker) return out;
    out.push(marker);
    cursor = marker.end;
  }
}

/** Split a user message into its visible text and any embedded images. */
export function parseUserContent(content: string): ParsedUserContent {
  const images: ParsedImage[] = [];
  let text = "";
  let cursor = 0;
  for (const marker of findImageMarkers(content)) {
    text += content.slice(cursor, marker.start);
    const data = marker.body.trim();
    if (data) images.push({ mediaType: marker.attrs.media_type, base64: data });
    cursor = marker.end;
  }
  text += content.slice(cursor);
  // Collapse the blank lines left where markers used to be.
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text, images };
}

/** True when the content carries at least one structurally valid image marker. */
export function hasImageMarker(content: string): boolean {
  return findImageMarker(content) !== null;
}
