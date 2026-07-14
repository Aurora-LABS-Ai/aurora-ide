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

import React, { useCallback, useMemo, useState } from "react";

import { writeClipboardText } from "../../lib/clipboard";
import { AgentIcon } from "../shared/AgentIcon";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentThinkingBlock } from "./AgentThinkingBlock";
import { AgentImageModal } from "./AgentImageModal";
import { ToolGroup } from "./ToolGroup";
import { CompactionCard } from "./CompactionCard";
import { buildRows, type TimelineEvent } from "./timeline";
import { parseUserContent } from "../lib/image-markers";
import { attachmentDataUrl } from "../store/useAgentAttachmentStore";
import { FileIcon } from "../../components/explorer/FileIcons";
import type {
  AttachedCommandChip,
  AttachedPromptChip,
  AttachedSelectedElement,
} from "../../services/thread-service";

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

function filePill(chip: AttachedPromptChip, key: React.Key): React.ReactNode {
  const path = chip.path || chip.value || chip.title;
  return (
    <span key={key} className="agw-pill-inline" title={path}>
      <FileIcon name={chip.title} path={path} className="agw-file-ico" />
      <span>{chip.title}</span>
    </span>
  );
}

function renderUserText(
  text: string,
  promptChips: AttachedPromptChip[],
): React.ReactNode {
  const files = promptChips.filter(
    (chip) => chip.kind === "file" && chip.value,
  );
  if (files.length > 0) {
    const out: React.ReactNode[] = [];
    let cursor = 0;
    files.forEach((chip, index) => {
      const marker = `@${chip.value}`;
      const at = text.indexOf(marker, cursor);
      if (at < 0) return;
      if (at > cursor) out.push(text.slice(cursor, at));
      out.push(filePill(chip, `file-${index}-${at}`));
      cursor = at + marker.length;
    });
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

/** Right-aligned user turn. Renders any embedded images above the text; an
 *  image click opens the full-size preview modal. */
const UserBubble: React.FC<{
  content: string;
  showActions: boolean;
  selectedElements?: AttachedSelectedElement[] | null;
  commands?: AttachedCommandChip[] | null;
  promptChips?: AttachedPromptChip[] | null;
}> = ({ content, showActions, selectedElements, commands, promptChips }) => {
  const { text, images } = useMemo(() => parseUserContent(content), [content]);
  const [preview, setPreview] = useState<string | null>(null);
  const chips = selectedElements ?? [];
  const exactChips = promptChips ?? [];
  const exactCommands = exactChips.filter(
    (chip): chip is AttachedPromptChip & { kind: AttachedCommandChip["kind"] } =>
      chip.kind !== "file",
  );
  const exactKeys = new Set(exactCommands.map((chip) => `${chip.kind}:${chip.title}`));
  const cmdChips = [
    ...exactCommands,
    ...(commands ?? []).filter((chip) => !exactKeys.has(`${chip.kind}:${chip.title}`)),
  ];
  const hasBubble = text.length > 0 || chips.length > 0 || cmdChips.length > 0;

  return (
    <div
      className="agw-msg"
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}
    >
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

      {hasBubble && (
        <div
          style={{
            maxWidth: "82%",
            padding: "9px 13px",
            borderRadius: 14,
            background: "var(--agw-bubble-user)",
            color: "var(--agw-text)",
            fontSize: 14,
            lineHeight: 1.55,
            border: "1px solid var(--agw-border)",
          }}
        >
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
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {renderUserText(text, exactChips)}
            </div>
          )}
        </div>
      )}

      {showActions && (hasBubble || images.length > 0) && (
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
          className={streaming ? "agw-shimmer" : undefined}
          style={{
            // Shrink to the text width. As a direct flex-column child it would
            // otherwise stretch to the full message width, so the 200% shimmer
            // canvas would be sized to the whole row (not the word) and the
            // sheen would fade out over the empty space before the right edge
            // instead of sweeping across the letters.
            alignSelf: "flex-start",
            fontSize: 11,
            fontWeight: 600,
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

      {rows.map((row) => {
        if (row.type === "thinking") {
          return (
            <AgentThinkingBlock
              key={row.id}
              content={row.text}
              isGenerating={row.id === activeThinkingId}
            />
          );
        }
        if (row.type === "content") {
          return (
            <AgentMarkdown
              key={row.id}
              content={row.text}
              streaming={streaming && row.id === lastContentId}
            />
          );
        }
        if (row.type === "user_injection") {
          // The user's mid-turn message, drained by the runtime at a tool-result
          // boundary and injected here — inline so it reads in the order the
          // model saw it (after the tool result, before the agent continues).
          return (
            <div key={row.id} className="agw-injection" title="You added this mid-turn">
              <AgentIcon name="message" size={13} />
              <span>{row.text}</span>
            </div>
          );
        }
        if (row.type === "compaction") {
          // Compaction fired here mid-turn — render inline so everything the
          // agent streamed AFTER it lands below the marker (and everything
          // before stays above), matching what the model actually re-ingested.
          return (
            <CompactionCard
              key={row.id}
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
          <ToolGroup key={row.id} tools={row.tools} isActivelyStreaming={streaming} />
        );
      })}

      {/* Streaming skeleton before any event arrives. */}
      {streaming && rows.length === 0 && (
        <div className="agw-skeleton">
          <span />
          <span />
        </div>
      )}

      {showActions && (copyText || onRetry) && (
        <div className="agw-msg-actions">
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
};

const MessageBubbleImpl: React.FC<MessageBubbleProps> = ({
  message,
  events = [],
  showLabel = true,
  streaming = false,
  showActions = true,
  onRetry,
  label,
  labelColor,
}) => {
  if (message.role === "user") {
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
