/**
 * Agent Window — message bubble [view].
 *
 * One transcript TURN. User turns render as a right-aligned bubble; assistant
 * turns render the model's events in the EXACT order it produced them —
 * reasoning, a spoken line, a tool, more text, more tools — by walking an
 * ordered timeline (`buildRows`) instead of the old fixed "thinking → tools →
 * content" layout (which wrongly shoved every tool above all the prose). This
 * mirrors the IDE's `ChatMessage` timeline rendering, re-themed with `--agw-*`.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { motion } from "framer-motion";

import { writeClipboardText } from "@/kernel/lib/clipboard";
import { inertWhen } from "@/kernel/lib/a11y/inert";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentMarkdown } from "@/apps/agent/components/conversation/AgentMarkdown";
import { AgentThinkingBlock } from "@/apps/agent/components/conversation/AgentThinkingBlock";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { ToolGroup } from "@/apps/agent/components/tools/ToolGroup";
import { ChapterHeading } from "@/apps/agent/components/conversation/ChapterHeading";
import { CompactionCard } from "@/apps/agent/components/conversation/CompactionCard";
import { NoticeCard } from "@/apps/agent/components/conversation/NoticeCard";
import { ReconnectCard } from "@/apps/agent/components/conversation/ReconnectCard";
import {
  buildRows,
  buildSections,
  formatWorkedDuration,
  type TimelineEvent,
  type TimelineRow,
} from "@/apps/agent/components/conversation/timeline";
import { parseUserContent } from "@/apps/agent/lib/render/image-markers";
import { attachmentDataUrl } from "@/apps/agent/store/composer/useAgentAttachmentStore";
import { FileIcon, FolderIcon } from "@/kernel/ui/FileIcons";
import type {
  AttachedCommandChip,
  AttachedPromptChip,
  AttachedSelectedElement,
} from "@/apps/agent/services/threads/thread-service";

/** Glyph per `/`-directive kind, mirroring the composer's command chips. */
const COMMAND_CHIP_ICON: Record<AttachedCommandChip["kind"], "book" | "shield" | "plug"> = {
  skill: "book",
  rule: "shield",
  mcp: "plug",
};

/**
 * `@`-file mentions in a sent message serialize to `@<path>` text. We render
 * those as compact file chips (basename only) instead of dumping the raw path —
 * matching the pill the composer showed. A path separator is REQUIRED to
 * qualify, so plain `@handles` and `@example.com` emails are never mistaken for
 * files. The model still receives the full `@<path>` in the message content;
 * this is display-only.
 */
const FILE_MENTION_RE = /@((?:[A-Za-z]:)?[^\s@]*[\\/][^\s@]+)/g;

function mentionBasename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Path chips (`file`, `folder`) render inline in the text; everything else in
 *  the command row. Kept as one predicate so the two sites can't disagree. */
function isPathChip(chip: AttachedPromptChip): boolean {
  return chip.kind === "file" || chip.kind === "folder";
}

function filePill(chip: AttachedPromptChip, key: React.Key): React.ReactNode {
  const path = chip.path || chip.value || chip.title;
  return (
    <span key={key} className="agw-pill-inline" title={path}>
      {chip.kind === "folder" ? (
        <FolderIcon name={chip.title} path={path} open={false} className="agw-file-ico" />
      ) : (
        <FileIcon name={chip.title} path={path} className="agw-file-ico" />
      )}
      <span>{chip.title}</span>
    </span>
  );
}

/** A chip with a command kind — narrowing used by the inline renderers. */
type CommandPromptChip = AttachedPromptChip & { kind: AttachedCommandChip["kind"] };

function cmdPill(chip: CommandPromptChip, key: React.Key): React.ReactNode {
  return (
    <span
      key={key}
      className="agw-pill-inline agw-pill-cmd"
      data-cmd-kind={chip.kind}
      title={`${chip.kind} · ${chip.title}`}
    >
      <span className="agw-pill-cmd-ico">
        <AgentIcon name={COMMAND_CHIP_ICON[chip.kind]} size={11} />
      </span>
      <span>{chip.title}</span>
    </span>
  );
}

/** The `@element:N` token an inspector pick serializes as in the sent text —
 *  the anchor both bubble kinds re-pill in place. */
const elementToken = (index: string | number) => `@element:${index}`;

/** Inline pill for a fresh turn's pick, anchored at its `@element:N` token.
 *  Same face as the composer's selection pill and the hoisted-row chip. */
function selectedElementPill(el: AttachedSelectedElement, key: React.Key): React.ReactNode {
  const elText = (el.text ?? "").trim();
  return (
    <span
      key={key}
      className="agw-pill-inline agw-pill-sel"
      title={`selector: ${el.selector}`}
    >
      <span className="agw-pill-cmd-ico">
        <AgentIcon name="inspect" size={11} />
      </span>
      <span className="agw-sel-tag">{`<${el.tagName}>`}</span>
      {elText && <span className="agw-sel-text">{elText.slice(0, 24)}</span>}
    </span>
  );
}

/** The chip for a browser-inspector pick riding a mid-turn injection. Same
 *  face as the composer's selection pill: inspect glyph, `<tag>`, clipped
 *  text; the selector lives in the tooltip. */
function elementPill(chip: AttachedPromptChip, key: React.Key): React.ReactNode {
  return (
    <span
      key={key}
      className="agw-pill-inline agw-pill-sel"
      title={chip.value ? `selector: ${chip.value}` : chip.title}
    >
      <span className="agw-pill-cmd-ico">
        <AgentIcon name="inspect" size={11} />
      </span>
      <span>{chip.title}</span>
    </span>
  );
}

/** The chip for an `@terminal` mention, anchored at its `@terminal:<id>` token. */
function terminalPill(chip: AttachedPromptChip, key: React.Key): React.ReactNode {
  return (
    <span
      key={key}
      className="agw-pill-inline agw-pill-term"
      title={`terminal · ${chip.title}`}
    >
      <span className="agw-pill-cmd-ico">
        <AgentIcon name="terminal" size={11} />
      </span>
      <span>{chip.title}</span>
    </span>
  );
}

/** The token an `@terminal` pill serializes as — the session id, not its name. */
const terminalToken = (chip: AttachedPromptChip) => `@terminal:${chip.value ?? ""}`;

/** The `/title` token a command pill serializes as in the sent text. */
const commandToken = (chip: AttachedPromptChip) => `/${chip.title}`;

/**
 * Command chips whose `/title` token appears in the text. These render INLINE
 * at their token's position (the spot the user put the pill) and must stay
 * out of the top chip row. Chips without a token — messages sent before
 * command pills serialized positionally — fall back to the top row.
 */
function commandChipsInline<T extends AttachedPromptChip>(text: string, chips: T[]): T[] {
  return chips.filter((chip) => !!chip.title && text.includes(commandToken(chip)));
}

function renderUserText(
  text: string,
  promptChips: AttachedPromptChip[],
  selectedElements?: AttachedSelectedElement[] | null,
): React.ReactNode {
  // Every chip that can anchor to a position in the text: file pills at
  // their `@rel` marker, command pills at their `/title` token, inspector
  // picks at their `@element:N` token. Rendered in TEXT order (earliest
  // remaining marker first), not chip-array order, so interleaved mentions
  // land exactly where the user put them.
  const candidates: Array<{
    marker: string;
    render: (key: React.Key) => React.ReactNode;
  }> = [];
  for (const chip of promptChips) {
    if (chip.kind === "terminal" && chip.value) {
      candidates.push({
        marker: terminalToken(chip),
        render: (key) => terminalPill(chip, key),
      });
    } else if (chip.kind === "element") {
      // Mid-turn injections: the pick rides as a chip whose `path` holds the
      // index its `@element:N` token names. Without a path (should not
      // happen) the chip renders at the head instead — see InjectionNote.
      if (chip.path) {
        candidates.push({
          marker: elementToken(chip.path),
          render: (key) => elementPill(chip, key),
        });
      }
    } else if (isPathChip(chip) && chip.value) {
      candidates.push({
        marker: `@${chip.value}`,
        render: (key) => filePill(chip, key),
      });
    } else if (!isPathChip(chip) && chip.kind !== "terminal" && chip.title) {
      const command = chip as CommandPromptChip;
      candidates.push({
        marker: commandToken(chip),
        render: (key) => cmdPill(command, key),
      });
    }
  }
  // Fresh turns: picks travel as `attachedSelectedElements` beside the text.
  for (const el of selectedElements ?? []) {
    candidates.push({
      marker: elementToken(el.index),
      render: (key) => selectedElementPill(el, key),
    });
  }
  if (candidates.length > 0) {
    const out: React.ReactNode[] = [];
    const pending = [...candidates];
    let cursor = 0;
    let key = 0;
    for (;;) {
      let bestIdx = -1;
      let bestAt = Number.POSITIVE_INFINITY;
      for (let i = 0; i < pending.length; i++) {
        const at = text.indexOf(pending[i].marker, cursor);
        if (at >= 0 && at < bestAt) {
          bestAt = at;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const [found] = pending.splice(bestIdx, 1);
      if (bestAt > cursor) out.push(text.slice(cursor, bestAt));
      out.push(found.render(`chip-${key++}`));
      cursor = bestAt + found.marker.length;
    }
    if (out.length > 0) {
      if (cursor < text.length) out.push(text.slice(cursor));
      return out;
    }
  }

  FILE_MENTION_RE.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_MENTION_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const path = m[1];
    out.push(
      filePill(
        { kind: "file", title: mentionBasename(path), value: path, path },
        `legacy-file-${key++}`,
      ),
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface BubbleMessage {
  role: string;
  /** User text, or the assistant turn's concatenated content (for copy). */
  content: string;
  /** Assistant only — true while the reasoning phase is live. */
  isThinking?: boolean | null;
  /** User only — browser-inspector element chips attached to this turn. */
  attachedSelectedElements?: AttachedSelectedElement[] | null;
  /** User only — `/`-attached skill / rule / MCP chips. */
  attachedCommands?: AttachedCommandChip[] | null;
  /** User only — exact file and directive pills captured from the composer. */
  attachedPromptChips?: AttachedPromptChip[] | null;
}

/** Copy button with a brief "Copied" confirmation (Tauri-safe clipboard). */
const CopyAction: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!text) return;
    void writeClipboardText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }, [text]);

  return (
    <button type="button" className="agw-msg-action" onClick={copy} title="Copy">
      <AgentIcon name={copied ? "check" : "copy"} size={13} />
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
};

/**
 * Fallback for the number of lines a long user message keeps while collapsed.
 *
 * The real value is `--agw-bubble-clamp-lines`, declared on `.agw-root` in the
 * stylesheet and halved for pinned questions — the measurement below reads it
 * back out of the computed style rather than restating it, so the height that
 * gets painted and the threshold that decides whether the chevron appears can
 * never disagree. This constant only covers the case where no stylesheet is
 * attached at all (jsdom in tests).
 */
const USER_BUBBLE_CLAMP_LINES = 6;

/**
 * Bubble content that clamps to its first lines and expands in place.
 *
 * Overflow is derived from the measured line-height rather than the usual
 * `scrollHeight > clientHeight`, because that comparison collapses to false the
 * moment the body expands — which would hide the control the reader needs to
 * collapse it again. `scrollHeight` reports full content height in BOTH states,
 * so comparing it against the clamp height stays correct throughout.
 */
const CollapsibleBubbleBody: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Layout timing, not effect timing: the clamp has to be applied before paint,
  // or a long message renders at full height for one frame and then snaps
  // shorter — a visible jolt part-way up the transcript.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const measure = () => {
      const style = getComputedStyle(el);
      const lineHeight = Number.parseFloat(style.lineHeight);
      // A non-numeric `line-height: normal` has no reliable px value; fall back
      // to the bubble's own defaults, 14px × 1.6 (`msgUserFontSize` /
      // `msgUserLineHeight` in themes.ts), so the estimate stays in range.
      const line = Number.isFinite(lineHeight) ? lineHeight : 22.4;
      // The clamp itself, straight from the stylesheet — it is 6 normally and 3
      // once the pinned treatment is on, and reading it means this measurement
      // follows that automatically instead of being told about it.
      const declared = Number.parseFloat(style.getPropertyValue("--agw-bubble-clamp-lines"));
      const lines = Number.isFinite(declared) && declared > 0 ? declared : USER_BUBBLE_CLAMP_LINES;
      // +1px absorbs sub-pixel rounding, which otherwise shows a chevron that
      // expands to reveal nothing.
      const next = el.scrollHeight > line * lines + 1;
      setOverflows(next);
      // Widening the window can make an expanded message fit again. Drop the
      // expanded flag with it, so it doesn't silently reappear expanded the
      // next time the pane narrows.
      if (!next) setExpanded(false);
    };

    measure();
    // Re-measure on width changes: the rails and the right dock resize the
    // transcript, and rewrapped text changes how many lines the same message
    // occupies.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  const collapsed = overflows && !expanded;

  return (
    <>
      <div
        ref={bodyRef}
        className="agw-bubble-body"
        data-collapsed={collapsed || undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="agw-bubble-more"
          data-expanded={expanded || undefined}
          aria-expanded={expanded}
          title={expanded ? "Show less" : "Show full message"}
          aria-label={expanded ? "Show less" : "Show full message"}
          onClick={() => setExpanded((v) => !v)}
        >
          <AgentIcon name="chevron-down" size={15} />
        </button>
      )}
    </>
  );
};

/** Right-aligned user turn. Attached images render INSIDE the card, above the
 *  text; an image click opens the full-size preview modal. */
const UserBubble: React.FC<{
  content: string;
  showActions: boolean;
  selectedElements?: AttachedSelectedElement[] | null;
  commands?: AttachedCommandChip[] | null;
  promptChips?: AttachedPromptChip[] | null;
}> = ({ content, showActions, selectedElements, commands, promptChips }) => {
  const { text, images } = useMemo(() => parseUserContent(content), [content]);
  const [preview, setPreview] = useState<string | null>(null);
  // Picks whose `@element:N` token is in the text re-pill INLINE at that spot
  // (renderUserText); the hoisted row carries only the rest — legacy messages
  // sent before the composer serialized picks positionally.
  const allSelected = selectedElements ?? [];
  const chips = allSelected.filter((el) => !text.includes(elementToken(el.index)));
  const exactChips = promptChips ?? [];
  const exactCommands = exactChips.filter(
    (chip): chip is CommandPromptChip =>
      // `element` excluded defensively: fresh turns carry picks as
      // `attachedSelectedElements`, but a chip that arrived here anyway must
      // not fall into `cmdPill`, whose icon map has no entry for it.
      !isPathChip(chip) && chip.kind !== "terminal" && chip.kind !== "element",
  );
  const exactKeys = new Set(exactCommands.map((chip) => `${chip.kind}:${chip.title}`));
  // Command pills whose `/title` token is in the text render INLINE at that
  // spot (renderUserText) — the top row carries only the rest: legacy chips
  // and messages sent before command pills serialized positionally.
  const inlineKeys = new Set(
    commandChipsInline(text, exactCommands).map((chip) => `${chip.kind}:${chip.title}`),
  );
  const cmdChips = [
    ...exactCommands.filter((chip) => !inlineKeys.has(`${chip.kind}:${chip.title}`)),
    ...(commands ?? []).filter(
      (chip) =>
        !exactKeys.has(`${chip.kind}:${chip.title}`) &&
        !inlineKeys.has(`${chip.kind}:${chip.title}`),
    ),
  ];
  // Text-ish content: what the clamp measures and what the "show more" chevron
  // is about. Images are deliberately NOT counted — they sit outside the
  // clamped body (see below).
  const hasText = text.length > 0 || chips.length > 0 || cmdChips.length > 0;
  const hasBubble = hasText || images.length > 0;

  return (
    <div
      className="agw-msg"
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}
    >
      {hasBubble && (
        <div
          // Fill AND padding live in CSS (`.agw-bubble-user`), not inline, so the
          // sticky-user treatment can override them. An inline style outranks
          // every selector: the fill was moved for that reason, and `padding`
          // stayed behind and silently beat the pinned card's
          // `padding-bottom: 28px` — the strip that keeps a question's last line
          // out from under the copy chip. The chip is absolutely positioned, so
          // losing that reserve put text directly beneath it.
          className="agw-bubble-user"
          style={{
            borderRadius: 14,
            color: "var(--agw-text)",
            // User-tunable in Settings → Appearance → Typography; the
            // fallbacks are the design defaults.
            fontSize: "var(--agw-msg-user-font-size, 14px)",
            lineHeight: "var(--agw-msg-user-line-height, 1.6)",
            border: "1px solid var(--agw-border)",
          }}
        >
          {/*
            INSIDE the card, and above the clamped body.

            Inside, because the attachment belongs to the question: while the
            sticky-user preference is on, the card is pinned, widened to the
            full column and capped at 34vh — and an image row parked outside it
            got none of that. It stayed hugging the right at 82% over a
            full-width band (a stray panel beside the question it belongs to),
            it escaped the height cap so a couple of 220px thumbnails made a
            pinned header that ate the viewport, and on an image-only message
            there was no card at all, so the absolutely-positioned copy chip
            landed on the picture. One parent fixes all three, and it matches
            the reference: `DOCS/visual-studies/antigravity/13-user-bubble-image.png`.

            Above the body rather than in it, because `CollapsibleBubbleBody`
            clamps its children to six LINES — measured off line-height. An
            image inside that measures as content and would be cut by a clamp
            meant for prose.
          */}
          {images.length > 0 && (
            <div className="agw-bubble-images">
              {images.map((img, i) => {
                const src = attachmentDataUrl(img);
                return (
                  <button
                    key={i}
                    type="button"
                    className="agw-bubble-image"
                    title="View image"
                    onClick={() => setPreview(src)}
                  >
                    <img src={src} alt="" draggable={false} />
                  </button>
                );
              })}
            </div>
          )}

          {hasText && (
            <CollapsibleBubbleBody>
              {cmdChips.length > 0 && (
                <div
                  className="agw-bubble-selected"
                  style={{ marginBottom: text || chips.length > 0 ? 7 : 0 }}
                >
                  {cmdChips.map((c, i) => (
                    <span
                      key={`${c.kind}-${c.title}-${i}`}
                      className="agw-pill-inline agw-pill-cmd"
                      data-cmd-kind={c.kind}
                      title={`${c.kind} · ${c.title}`}
                    >
                      <span className="agw-pill-cmd-ico">
                        <AgentIcon name={COMMAND_CHIP_ICON[c.kind]} size={11} />
                      </span>
                      <span>{c.title}</span>
                    </span>
                  ))}
                </div>
              )}

              {chips.length > 0 && (
                <div
                  className="agw-bubble-selected"
                  style={{ marginBottom: text ? 7 : 0 }}
                >
                  {chips.map((el) => {
                    const elText = (el.text ?? "").trim();
                    const tip = [
                      `selector: ${el.selector}`,
                      `tag: <${el.tagName}>`,
                      el.url ? `url: ${el.url}` : null,
                    ]
                      .filter(Boolean)
                      .join("\n");
                    return (
                      <span key={el.index} className="agw-sel-chip" title={tip}>
                        <AgentIcon name="inspect" size={11} />
                        <span className="agw-sel-tag">{`<${el.tagName}>`}</span>
                        {elText && (
                          <span className="agw-sel-text">{elText.slice(0, 24)}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}

              {text && (
                <div
                  // Named so the pinned-bubble rules can reserve the copy chip's
                  // footprint at the end of THIS text, rather than as a strip
                  // under the whole message. See 11-transcript-bubbles.css.
                  className="agw-bubble-text"
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                >
                  {renderUserText(text, exactChips, allSelected)}
                </div>
              )}
            </CollapsibleBubbleBody>
          )}
        </div>
      )}

      {showActions && hasBubble && (
        <div className="agw-msg-actions" style={{ marginTop: 4 }}>
          <CopyAction text={text} />
        </div>
      )}

      <AgentImageModal
        open={preview !== null}
        mode="preview"
        src={preview}
        onClose={() => setPreview(null)}
      />
    </div>
  );
};

/**
 * Mid-turn user note, rendered inline in the assistant timeline at the exact
 * tool-result boundary the runtime injected it.
 *
 * Everything a user bubble carries renders here the same way: `/` command
 * pills inline at their token's position (top-prefixed only when a chip has
 * no token — pre-positional messages), `@` mentions as file pills replacing
 * their `@rel` markers, and `<aurora_image>` attachments as clickable
 * thumbnails — the text shown is the marker-stripped human copy.
 */
const InjectionNote: React.FC<{
  text: string;
  chips?: AttachedPromptChip[] | null;
}> = ({ text, chips }) => {
  const { text: bodyText, images } = useMemo(() => parseUserContent(text), [text]);
  const [preview, setPreview] = useState<string | null>(null);
  const allChips = chips ?? [];
  const commandChips = allChips.filter(
    (chip): chip is CommandPromptChip =>
      !isPathChip(chip) && chip.kind !== "terminal" && chip.kind !== "element",
  );
  // Inspector picks anchor at their `@element:N` token (renderUserText); the
  // head carries only ones with no token in the text — a fallback that should
  // not occur for messages sent after picks serialized positionally.
  const elementChips = allChips.filter(
    (chip) =>
      chip.kind === "element" &&
      !(chip.path && bodyText.includes(elementToken(chip.path))),
  );
  const inlineKeys = new Set(
    commandChipsInline(bodyText, commandChips).map((chip) => `${chip.kind}:${chip.title}`),
  );
  const headChips = commandChips.filter(
    (chip) => !inlineKeys.has(`${chip.kind}:${chip.title}`),
  );

  return (
    <div className="agw-injection" title="You added this mid-turn">
      <AgentIcon name="message" size={13} />
      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {elementChips.map((chip, i) => elementPill(chip, `el-${chip.title}-${i}`))}
        {headChips.map((chip, i) => cmdPill(chip, `head-${chip.kind}-${chip.title}-${i}`))}
        {renderUserText(bodyText, allChips)}
        {images.length > 0 && (
          <span className="agw-bubble-images" style={{ display: "flex", marginTop: 6 }}>
            {images.map((img, i) => {
              const src = attachmentDataUrl(img);
              return (
                <button
                  key={i}
                  type="button"
                  className="agw-bubble-image"
                  title="View image"
                  onClick={() => setPreview(src)}
                >
                  <img src={src} alt="" draggable={false} />
                </button>
              );
            })}
          </span>
        )}
      </span>
      <AgentImageModal
        open={preview !== null}
        mode="preview"
        src={preview}
        onClose={() => setPreview(null)}
      />
    </div>
  );
};

/**
 * Quiet "Worked 4m" readout in the turn footer.
 *
 * While the turn is live it ticks from the moment the user sent, so a long
 * turn is legible as it happens rather than only in hindsight — a stalled run
 * is the case where this number matters most. Once settled it shows the
 * derived total and stops.
 *
 * Deliberately the lowest-contrast thing in the row: it is information you
 * glance at, never an action competing with Copy or Retry.
 */
const WorkedDuration: React.FC<{
  workedMs: number | null;
  startedAt?: string;
  streaming: boolean;
}> = ({ workedMs, startedAt, streaming }) => {
  const startMs = useMemo(() => {
    if (!startedAt) return null;
    const parsed = Date.parse(startedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [startedAt]);
  // A clock, not derived state: the effect only advances `now`, and the
  // duration is computed during render. Seeding it at mount keeps the first
  // paint correct instead of blank for a second.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!streaming) return;
    // One second is the smallest unit the label shows, so a faster tick would
    // re-render for nothing.
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [streaming]);

  const shown = streaming && startMs !== null ? now - startMs : workedMs;
  if (shown === null || shown === undefined || shown <= 0) return null;

  return (
    <span
      className="agw-msg-worked"
      title={streaming ? "Time on this turn so far" : "Time the agent spent on this turn"}
    >
      {streaming ? "Working" : "Worked"} {formatWorkedDuration(shown)}
    </span>
  );
};

/** Assistant turn — ordered timeline + label + actions. */
const AssistantTurn: React.FC<{
  copyText: string;
  events: TimelineEvent[];
  isThinking: boolean;
  showLabel: boolean;
  streaming: boolean;
  showActions: boolean;
  onRetry?: () => void;
  label?: string;
  labelColor?: string;
  /** Wall-clock this turn took, or null when it cannot be derived. */
  workedMs?: number | null;
  /** When the live turn began, for the ticking counter. */
  startedAt?: string;
}> = ({
  copyText,
  events,
  isThinking,
  showLabel,
  streaming,
  showActions,
  onRetry,
  label,
  labelColor,
  workedMs,
  startedAt,
}) => {
  const rows = useMemo(() => buildRows(events), [events]);
  const lastContentId = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].type === "content") return rows[i].id;
    }
    return null;
  }, [rows]);
  // Only ONE thinking block is "live" at a time: the LAST row, and only while the
  // reasoning flag is set (the hook flips `isThinking` off the instant any
  // content/tool arrives). Earlier reasoning segments already finished, so they
  // collapse to a quiet "Reasoning" toggle instead of all staying expanded.
  const activeThinkingId = useMemo(() => {
    const last = rows[rows.length - 1];
    return isThinking && last?.type === "thinking" ? last.id : null;
  }, [rows, isThinking]);

  // ── Chapters ───────────────────────────────────────────────────────────
  // A chapter owns every row until the next chapter, and only the CURRENT one
  // stays expanded: the moment the agent names a new part of the work, the
  // previous part has finished and folds to its title.
  // The turn's end closes the LAST chapter's span. Derived from the two numbers
  // the header already has (`workedMs` is end − start), so nothing new is
  // threaded down. Withheld while streaming: that chapter is still being
  // worked, and a heading is not the place for a running clock.
  const turnEndedAt = useMemo(() => {
    if (streaming || !startedAt || workedMs == null) return undefined;
    const start = Date.parse(startedAt);
    return Number.isFinite(start) ? start + workedMs : undefined;
  }, [streaming, startedAt, workedMs]);
  const sections = useMemo(() => buildSections(rows, turnEndedAt), [rows, turnEndedAt]);
  const activeChapterId = useMemo(() => {
    for (let i = sections.length - 1; i >= 0; i--) {
      const id = sections[i].chapter?.id;
      if (id) return id;
    }
    return null;
  }, [sections]);

  /**
   * The reader's own toggles, each stamped with the chapter that was active
   * when it was made.
   *
   * The stamp is what makes "a new chapter collapses the previous one" hold
   * without an effect: an override only applies while the era it was made in is
   * still current, so a new chapter expires every override at once and each
   * chapter falls back to its default (open iff it is the active one). Deriving
   * it this way also keeps this component free of `set-state-in-effect`, which
   * this codebase lints as an error.
   */
  const [chapterOverrides, setChapterOverrides] = useState<
    Record<string, { open: boolean; era: string | null }>
  >({});

  const isChapterOpen = (id: string): boolean => {
    const override = chapterOverrides[id];
    if (override && override.era === activeChapterId) return override.open;
    return id === activeChapterId;
  };

  const toggleChapter = (id: string) => {
    const next = !isChapterOpen(id);
    setChapterOverrides((prev) => ({ ...prev, [id]: { open: next, era: activeChapterId } }));
  };

  /** `index` is the row's position in the FLAT turn list — see
   *  `renderRowWrapper` for why it is turn-wide and not chapter-local. */
  const renderRow = (row: TimelineRow, index: number) => {
    if (row.type === "thinking") {
      return (
        <AgentThinkingBlock
          content={row.text}
          isGenerating={row.id === activeThinkingId}
          startedAt={row.startedAt}
          durationMs={row.durationMs}
        />
      );
    }
    if (row.type === "content") {
      return (
        <AgentMarkdown
          content={row.text}
          streaming={streaming && row.id === lastContentId}
        />
      );
    }
    if (row.type === "user_injection") {
      // The user's mid-turn message, drained by the runtime at a tool-result
      // boundary and injected here — inline so it reads in the order the
      // model saw it (after the tool result, before the agent continues).
      return <InjectionNote text={row.text} chips={row.chips} />;
    }
    if (row.type === "chapter") {
      // Unreachable: `buildSections` lifts every chapter row out into a section
      // header. Kept so this stays exhaustive over `TimelineRow`.
      return null;
    }
    if (row.type === "notice") {
      // A runtime message (output limit hit, stream dropped), rendered where
      // it happened and visibly NOT part of what the model wrote.
      return <NoticeCard text={row.text} />;
    }
    if (row.type === "reconnect") {
      // The stream died here and is being re-requested. Sits exactly where the
      // discarded half-reply was, and is removed when the retry starts — so a
      // recovered connection leaves the transcript looking untouched.
      return <ReconnectCard attempt={row.attempt} maxAttempts={row.maxAttempts} />;
    }
    if (row.type === "compaction") {
      // Compaction fired here mid-turn — render inline so everything the
      // agent streamed AFTER it lands below the marker (and everything
      // before stays above), matching what the model actually re-ingested.
      return (
        <CompactionCard
          beforeTokens={row.beforeTokens}
          afterTokens={row.afterTokens}
          running={row.running}
        />
      );
    }
    // tools — ALWAYS render through ToolGroup (even a single call). It shows
    // the collapsible header only once the run reaches TOOL_GROUP_MIN, but
    // because the component type never changes, the cards stay mounted and
    // the header animates in instead of the whole row jumping at the 6th call.
    return (
      <ToolGroup
        tools={row.tools}
        isActivelyStreaming={streaming}
        // Once anything lands below this run it stops being the live edge and
        // folds back to its summary, so the newest output stays in view.
        isLastRow={index === rows.length - 1}
      />
    );
  };

  /**
   * One row in its wrapper.
   *
   * `index` is the row's position in the FLAT list, not within its chapter —
   * the spine's rail is drawn per turn, so "is this the last row" and "is this
   * the live frontier" are turn-wide questions. Passing a chapter-local index
   * would terminate the rail at every chapter break and put a shimmer on the
   * last row of every collapsed section.
   */
  const renderRowWrapper = (row: TimelineRow, index: number) => (
    // Every row carries the same wrapper, on every turn, whether or not an
    // opt-in transcript treatment is on. It is the single hook those
    // treatments style — and keeping it unconditional means switching one on
    // re-styles the transcript without remounting a row, so open tool groups
    // and scroll position survive the toggle.
    <div
      key={row.id}
      className="agw-row"
      data-row={row.type}
      // The spine's connector bridges the gap to the NEXT row, so the last
      // one must not draw a line into empty space below the turn.
      data-last={index === rows.length - 1 || undefined}
      // The frontier of a live turn: the row being written right now. The
      // spine's marker shimmers here and nowhere else, so the eye can find
      // where the work is without following the whole column.
      data-live={(streaming && index === rows.length - 1) || undefined}
    >
      {/* The spine's branch — the curve that leaves the rail and turns
          into this row. It needs its own box because the wrapper's two
          pseudo-elements are already spent on the rail and the marker,
          and a curve is a third shape. Rendered unconditionally and
          display:none by default, exactly like the wrapper itself, so
          toggling the spine never remounts a row. */}
      <i className="agw-row-branch" aria-hidden="true" />
      {renderRow(row, index)}
    </div>
  );

  return (
    <div
      className="agw-msg agw-msg-assistant"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      {showLabel && (
        <span
          // While the turn streams, the label breathes with the SAME shimmer as
          // the "Thinking…" reasoning label (`agw-shimmer` clips a moving
          // gradient onto the text, so no inline color while it's live).
          className={streaming ? "agw-turn-label agw-shimmer" : "agw-turn-label"}
          style={{
            // Shrink to the text width. As a direct flex-column child it would
            // otherwise stretch to the full message width, so the 200% shimmer
            // canvas would be sized to the whole row (not the word) and the
            // sheen would fade out over the empty space before the right edge
            // instead of sweeping across the letters.
            alignSelf: "flex-start",
            fontSize: "var(--agw-fs-micro)",
            fontWeight: "var(--agw-fw-medium)",
            letterSpacing: 0.4,
            textTransform: "uppercase",
            ...(streaming
              ? null
              : { color: labelColor ?? "var(--agw-text-subtle)" }),
          }}
        >
          {label ?? "Aurora"}
        </span>
      )}

      {sections.map((section) => {
        const body = section.rows.map(({ row, index }) => renderRowWrapper(row, index));
        if (!section.chapter) return body;

        const { id, title, index, durationMs: chapterMs } = section.chapter;
        const open = isChapterOpen(id);
        const bodyId = `agw-chapter-body-${id}`;
        return (
          <React.Fragment key={id}>
            {/* The heading keeps the SAME `.agw-row` wrapper every other row
                carries, so every spine rule written for `[data-row="chapter"]`
                (its filled marker, its lowered branch, its first-child case)
                keeps applying unchanged. Only the body below it is new. */}
            <div
              className="agw-row"
              data-row="chapter"
              // A chapter is `last` only when the agent has named the work but
              // not started it yet — otherwise its own body carries the rail on.
              data-last={index === rows.length - 1 || undefined}
              data-live={(streaming && index === rows.length - 1) || undefined}
            >
              <i className="agw-row-branch" aria-hidden="true" />
              <ChapterHeading
                title={title}
                open={open}
                bodyId={bodyId}
                durationMs={chapterMs}
                onToggle={() => toggleChapter(id)}
              />
            </div>
            <motion.div
              id={bodyId}
              className="agw-chapter-body"
              // `initial={false}` so a reloaded turn paints its collapsed
              // chapters already closed instead of animating them shut on
              // mount — the transcript would otherwise lurch on every open.
              initial={false}
              animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ overflow: "hidden" }}
              // Collapsed content stays mounted (so tool cards keep their own
              // state and the reopen is instant) but must leave the tab order
              // AND the a11y tree — a zero-height box is still focusable, so
              // without this, tabbing through a turn walks invisible cards.
              {...inertWhen(!open)}
            >
              {body}
            </motion.div>
          </React.Fragment>
        );
      })}

      {/* Streaming skeleton before any event arrives. */}
      {streaming && rows.length === 0 && (
        <div className="agw-skeleton">
          <span />
          <span />
        </div>
      )}

      {showActions && (copyText || onRetry || workedMs !== null) && (
        <div className="agw-msg-actions">
          <WorkedDuration
            workedMs={workedMs ?? null}
            startedAt={startedAt}
            streaming={streaming}
          />
          {copyText && <CopyAction text={copyText} />}
          {onRetry && (
            <button type="button" className="agw-msg-action" onClick={onRetry} title="Retry">
              <AgentIcon name="retry" size={13} />
              <span>Retry</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

type MessageBubbleProps = {
  message: BubbleMessage;
  /** Assistant only — ordered events for this turn. */
  events?: TimelineEvent[];
  /** Whether to render the "Aurora" label (first/only block of a turn). */
  showLabel?: boolean;
  /** This turn is the last one and is still streaming. */
  streaming?: boolean;
  /** Show the hover action row (Copy / Retry). */
  showActions?: boolean;
  /** When provided (assistant only), shows a Retry action that resends. */
  onRetry?: () => void;
  /** Label text over an assistant turn (defaults to "Aurora"). The Team
   *  screen passes the speaking member's name so a teammate's message renders
   *  through the exact same chat turn, just labeled. */
  label?: string;
  /** Idle color for a custom label (streaming keeps the shimmer). */
  labelColor?: string;
  /**
   * Wall-clock this assistant turn took. Derived by `turnWorkedMs` from
   * timestamps the runtime already persists — nothing extra is recorded.
   */
  workedMs?: number | null;
  /** When the turn began, so a live turn can tick rather than sit blank. */
  startedAt?: string;
};

/**
 * Team traces in the main chat. The notifier injects team traffic into the
 * Lead's conversation as user-role turns (so the model has the full text),
 * but the WORDS belong to the Team chat — the main chat shows only a compact
 * trace pill. Clicking it opens the Team panel where the content lives.
 * Detection is by the notifier's own stable markers, nothing heuristic.
 */
const TEAM_QUESTION_RE = /^\[Team question — (.+?) is paused/;
const TEAM_NOTIFICATION_PREFIX = "[Automatic team notification";

const teamTrace = (content: string): { title: string; tone: "ask" | "done" } | null => {
  const q = TEAM_QUESTION_RE.exec(content);
  if (q) return { title: `${q[1]} messaged you`, tone: "ask" };
  if (content.startsWith(TEAM_NOTIFICATION_PREFIX))
    return { title: "Team run finished — report requested", tone: "done" };
  return null;
};

const TeamTracePill: React.FC<{ title: string; tone: "ask" | "done" }> = ({ title, tone }) => (
  <div
    className="agw-msg"
    style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}
  >
    <button
      type="button"
      className="agw-team-trace"
      data-tone={tone}
      title="Open the Team panel"
      onClick={() => {
        // Lazy import avoids a cycle: the workspace store imports dock types
        // that components also use.
        void import("@/apps/agent/store/workspace/useAgentWorkspaceStore").then((m) =>
          m.useAgentWorkspaceStore.getState().openTab("team"),
        );
      }}
    >
      <span className="agw-team-trace-dot" />
      <span>{title}</span>
      <AgentIcon name="users" size={12} />
    </button>
  </div>
);

const MessageBubbleImpl: React.FC<MessageBubbleProps> = ({
  message,
  events = [],
  showLabel = true,
  streaming = false,
  showActions = true,
  onRetry,
  label,
  labelColor,
  workedMs,
  startedAt,
}) => {
  if (message.role === "user") {
    const trace = teamTrace(message.content);
    if (trace) return <TeamTracePill title={trace.title} tone={trace.tone} />;
    return (
      <UserBubble
        content={message.content}
        showActions={showActions}
        selectedElements={message.attachedSelectedElements}
        commands={message.attachedCommands}
        promptChips={message.attachedPromptChips}
      />
    );
  }
  return (
    <AssistantTurn
      copyText={message.content}
      events={events}
      isThinking={!!message.isThinking}
      showLabel={showLabel}
      streaming={streaming}
      showActions={showActions}
      onRetry={onRetry}
      label={label}
      labelColor={labelColor}
      workedMs={workedMs ?? null}
      startedAt={startedAt}
    />
  );
};

/**
 * Re-render policy — the fix for streaming frame-drops that grow with
 * conversation length.
 *
 * The store updates the open thread on EVERY streamed token, so the parent
 * re-runs `buildTurns` and re-renders the whole turn list each token. Without
 * memoization, that means every completed bubble re-parses its markdown and
 * re-runs Shiki highlighting on every token — O(turns) of expensive work per
 * token, which is why it degrades as the chat grows and snaps back to smooth
 * the instant streaming stops.
 *
 * A completed turn is immutable during a stream — only the ACTIVE (streaming)
 * turn changes. So: always re-render while `streaming` is (or was) true; for
 * idle turns, skip unless something visible actually changed. `message` and
 * `events` arrive as fresh references each render (inline object / rebuilt
 * array), so we compare by VALUE, not identity. A completed turn never mutates
 * its events, so an event-count check is a sufficient, cheap signal.
 */
/** How many tool events in a timeline carry a landed (non-null) result. */
function resolvedToolResults(events?: TimelineEvent[]): number {
  let n = 0;
  for (const e of events ?? []) {
    if (e.kind === "tool" && e.call.result != null) n += 1;
  }
  return n;
}

function bubblePropsEqual(
  prev: MessageBubbleProps,
  next: MessageBubbleProps,
): boolean {
  // The active turn grows every token; also re-render once on the
  // streaming→idle transition so the final state settles.
  if (prev.streaming || next.streaming) return false;

  if (prev.showLabel !== next.showLabel) return false;
  if (prev.showActions !== next.showActions) return false;
  if (!!prev.onRetry !== !!next.onRetry) return false;
  if (prev.label !== next.label) return false;
  if (prev.labelColor !== next.labelColor) return false;

  const a = prev.message;
  const b = next.message;
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (!!a.isThinking !== !!b.isThinking) return false;
  if ((prev.events?.length ?? 0) !== (next.events?.length ?? 0)) return false;
  // A tool RESULT can land without changing the event count (the call event
  // already existed; only its `result` filled in). Without this check an idle
  // bubble keeps showing the tool as pending/failed until the NEXT event
  // arrives — the team transcript's "Didn't complete until the next tool call"
  // bug. Counting resolved/failed results is cheap and catches the transition.
  if (resolvedToolResults(prev.events) !== resolvedToolResults(next.events)) {
    return false;
  }
  if (
    (a.attachedCommands?.length ?? 0) !== (b.attachedCommands?.length ?? 0)
  ) {
    return false;
  }
  if (
    (a.attachedPromptChips?.length ?? 0) !==
    (b.attachedPromptChips?.length ?? 0)
  ) {
    return false;
  }
  if (
    (a.attachedSelectedElements?.length ?? 0) !==
    (b.attachedSelectedElements?.length ?? 0)
  ) {
    return false;
  }
  // Equal → keep the existing render (skips markdown + Shiki re-work).
  return true;
}

export const MessageBubble = React.memo(MessageBubbleImpl, bubblePropsEqual);
