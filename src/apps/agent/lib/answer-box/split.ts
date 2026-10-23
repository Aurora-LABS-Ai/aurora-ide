/**
 * Cut a reply into markdown, answer boxes and — with Transcript → Reply
 * layout on — layout blocks (`lib/reply-layout`).
 *
 * Done on the raw text, before markdown sees it, so a block knows the one
 * thing the renderer cannot tell it: whether its closing fence has arrived.
 * An open fence means the model is still writing it.
 */

import { isLayoutLanguage, type LayoutLanguage } from "@/apps/agent/lib/reply-layout/parse";
import { UI_FENCE_LANGUAGE, type UiFenceLanguage } from "@/apps/agent/lib/reply-layout/ui";

export const BOX_FENCE_LANGUAGE = "aurora-box";

/** A fence the reply layout draws: one block, or a whole `aurora-ui` layout. */
export type ReplyFenceLanguage = LayoutLanguage | UiFenceLanguage;

function isReplyFence(info: string): info is ReplyFenceLanguage {
  return info === UI_FENCE_LANGUAGE || isLayoutLanguage(info);
}

export type ReplySegment =
  | { kind: "markdown"; text: string }
  | { kind: "box"; source: string; closed: boolean; raw: string }
  | { kind: "layout"; language: ReplyFenceLanguage; source: string; closed: boolean; raw: string };

/** An opening or closing fence: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Fence names that mean "no language": the model forgot to name it. */
const UNNAMED = new Set(["", "text", "plain", "plaintext"]);

/**
 * The first line of a reply-language layout: `name = Part(`. Models write the
 * language right and forget the fence name (MiniMax M3.1, 2026-10-23: a whole
 * architecture layout drawn as a code block). Only the assignment form counts,
 * so `Text("hi")` in a Compose or Flutter snippet stays code.
 */
const UI_FIRST_LINE =
  /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:Page|Facts|Flow|Note|Bars|Pairs|Compare|Checklist|Timeline|Tree|Stats|Diagram|Text|Link|Sources)\s*\(/;
/** The same, on any line: the cheap check before the reply is cut at all. */
const UI_FIRST_LINE_ANYWHERE = new RegExp(UI_FIRST_LINE.source, "m");

export interface SplitOptions {
  /** Cut registered reply-layout fences out too. Off,
   *  they stay markdown and render as code, which is what the setting being
   *  off means. */
  layouts?: boolean;
}

/**
 * Fences are tracked properly, so a box shown INSIDE another code block (the
 * model explaining the format) stays text.
 */
export function splitReply(text: string, { layouts = false }: SplitOptions = {}): ReplySegment[] {
  const mightHold =
    text.includes(BOX_FENCE_LANGUAGE) || (layouts && (text.includes("aurora-") || UI_FIRST_LINE_ANYWHERE.test(text)));
  if (!mightHold) return [{ kind: "markdown", text }];

  const lines = text.split("\n");
  const segments: ReplySegment[] = [];
  let markdown: string[] = [];
  let open: {
    marker: string;
    /** What the fence opened: a box, a layout block, or ordinary code. */
    cut: "box" | ReplyFenceLanguage | null;
    /** An unnamed fence before its first line: layout or code is not known yet. */
    pending?: boolean;
    lines: string[];
    opener: string;
  } | null = null;

  const flushMarkdown = () => {
    if (markdown.length > 0) {
      const chunk = markdown.join("\n");
      if (chunk.trim()) segments.push({ kind: "markdown", text: chunk });
      markdown = [];
    }
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (!open) {
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        const info = fence[2].trim().split(/\s+/)[0] ?? "";
        const cut: "box" | ReplyFenceLanguage | null =
          info === BOX_FENCE_LANGUAGE ? "box" : layouts && isReplyFence(info) ? info : null;
        const pending = !cut && layouts && UNNAMED.has(info);
        open = { marker: fence[1], cut, pending, lines: [], opener: line };
        if (cut) flushMarkdown();
        else if (!pending) markdown.push(line);
        continue;
      }
      markdown.push(line);
      continue;
    }
    const closes =
      fence !== null &&
      fence[1][0] === open.marker[0] &&
      fence[1].length >= open.marker.length &&
      fence[2].trim() === "";
    if (open.pending) {
      if (!closes && !line.trim()) {
        open.lines.push(line);
        continue;
      }
      // The first line decides: a layout statement, or ordinary code.
      open.pending = false;
      if (!closes && UI_FIRST_LINE.test(line)) {
        open.cut = UI_FENCE_LANGUAGE;
        flushMarkdown();
      } else {
        markdown.push(open.opener, ...open.lines);
        open.lines = [];
      }
    }
    if (open.cut) {
      if (closes) {
        const source = open.lines.join("\n");
        const raw = [open.opener, ...open.lines, line].join("\n");
        segments.push(
          open.cut === "box"
            ? { kind: "box", source, closed: true, raw }
            : { kind: "layout", language: open.cut, source, closed: true, raw },
        );
        open = null;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    markdown.push(line);
    if (closes) open = null;
  }

  if (open?.cut) {
    // Still streaming. Keep the trailing newline the model has written so far,
    // so the parser can tell a finished last line from a half-written one.
    const source = open.lines.join("\n") + (text.endsWith("\n") ? "\n" : "");
    const raw = [open.opener, ...open.lines].join("\n");
    segments.push(
      open.cut === "box"
        ? { kind: "box", source, closed: false, raw }
        : { kind: "layout", language: open.cut, source, closed: false, raw },
    );
  } else {
    // An unnamed fence with nothing in it yet is code until it says otherwise.
    if (open?.pending) markdown.push(open.opener, ...open.lines);
    flushMarkdown();
  }
  return segments;
}

/**
 * Where a box's settings are saved: its own text, hashed.
 *
 * Not a message id. A box streamed live and the same box read back from disk
 * come from two different producers, and their ids need not agree; their
 * text always does. Two identical boxes in one conversation share settings,
 * which is the right answer for two copies of the same tool.
 */
export function boxKey(source: string): string {
  // FNV-1a, 32-bit, over UTF-16 code units, plus the length to spread collisions.
  let hash = 0x811c9dc5;
  const text = source.trim();
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `b${hash.toString(16).padStart(8, "0")}${text.length.toString(36)}`;
}
