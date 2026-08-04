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

import { writeClipboardText } from "../../lib/clipboard";
import { AgentIcon } from "../shared/AgentIcon";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentThinkingBlock } from "./AgentThinkingBlock";
import { AgentImageModal } from "./AgentImageModal";
import { ToolGroup } from "./ToolGroup";
import { CompactionCard } from "./CompactionCard";
import { NoticeCard } from "./NoticeCard";
import { buildRows, formatWorkedDuration, type TimelineEvent } from "./timeline";
import { parseUserContent } from "../lib/image-markers";
import { attachmentDataUrl } from "../store/useAgentAttachmentStore";
import { FileIcon, FolderIcon } from "../../components/explorer/FileIcons";
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

function renderUserText(
  text: string,
  promptChips: AttachedPromptChip[],
): React.ReactNode {
  const files = promptChips.filter((chip) => isPathChip(chip) && chip.value);
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

/**
 * Lines of a long user message kept visible while collapsed. Must match the
 * `calc(1.55em * 6)` clamp on `.agw-bubble-body[data-collapsed]` — the CSS owns
 * the height, this only decides when the chevron is worth showing.
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
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      // A non-numeric `line-height: normal` has no reliable px value; fall back
      // to the bubble's 14px × 1.55 so the estimate stays in the right range.
      const line = Number.isFinite(lineHeight) ? lineHeight : 21.7;
      // +1px absorbs sub-pixel rounding, which otherwise shows a chevron that
      // expands to reveal nothing.
      const next = el.scrollHeight > line * USER_BUBBLE_CLAMP_LINES + 1;
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
      !isPathChip(chip),
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
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {renderUserText(text, exactChips)}
              </div>
            )}
          </CollapsibleBubbleBody>
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
            fontSize: 11,
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
        if (row.type === "notice") {
          // A runtime message (output limit hit, stream dropped), rendered where
          // it happened and visibly NOT part of what the model wrote.
          return <NoticeCard key={row.id} text={row.text} />;
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
        void import("../store/useAgentWorkspaceStore").then((m) =>
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
