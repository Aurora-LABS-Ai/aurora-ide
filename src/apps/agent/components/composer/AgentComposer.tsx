/**
 * Agent Window — composer [view].
 *
 * A contenteditable input (NOT a textarea) so an `@`-mention drops a real PILL
 * **inline at the cursor** — e.g. "check @file-index.ts then report back" — exactly
 * where you typed `@`, Codex-style. Pills are non-editable spans; backspace
 * deletes a whole pill. On send the input is serialized to plain text where each
 * pill becomes its `@<relative-path>` token in place, so the agent sees the file
 * reference at the right spot in the sentence.
 *
 * Themed purely with `--agw-*`. No focus halos — deliberate.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { StreamingDotMatrix } from "@/apps/agent/components/theme/StreamingDotMatrix";
import { openFileDialog } from "@/kernel/lib/ipc/tauri";
import { FileIcon } from "@/kernel/ui/FileIcons";
import { resolveExplorerIcon } from "@/kernel/lib/icons/icon-registry";
import {
  listTerminalSessions,
  type TerminalSessionSummary,
} from "@/apps/agent/services/terminal/terminal-sessions";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { ModelSelector } from "@/apps/agent/components/composer/ModelSelector";
import { ComposerMenu } from "@/apps/agent/components/composer/ComposerMenu";
import {
  ComposerPlusMenu,
  type PlusMenuItem,
} from "@/apps/agent/components/composer/ComposerPlusMenu";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { ComposerRail } from "@/apps/agent/components/composer-rail/ComposerRail";
import {
  invalidateFileIndex,
  loadFileIndex,
  rankFiles,
  relativize,
  type MentionFile,
} from "@/apps/agent/adapters/file-index";
import {
  invalidatePromptCommands,
  loadPromptCommands,
  rankCommands,
  type PromptCommand,
  type PromptCommandKind,
} from "@/apps/agent/adapters/prompt-commands";
import { composerCommands, useAgentCommandStore } from "@/apps/agent/store/composer/useAgentCommandStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { pinnedThreadModel } from "@/apps/agent/lib/thread/thread-model";
import {
  useAgentSelectionStore,
  type SelectedEntry,
} from "@/apps/agent/store/composer/useAgentSelectionStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { useAgentSpeech } from "@/apps/agent/hooks/composer/useAgentSpeech";
import { useAgentExternalDrop } from "@/apps/agent/hooks/drag/useAgentExternalDrop";
import { useAgentPathDrop } from "@/apps/agent/hooks/drag/useAgentPathDrop";
import { useComposerTyping } from "@/apps/agent/hooks/composer/useComposerTyping";
import { useComposerRefine } from "@/apps/agent/hooks/composer/useComposerRefine";
import { MAX_REFINE_CHARS } from "@/apps/agent/adapters/prompt-refine";
import {
  attachmentDataUrl,
  composerImages,
  composerKey,
  useAgentAttachmentStore,
  type ImageAttachment,
} from "@/apps/agent/store/composer/useAgentAttachmentStore";
import {
  basenameOf,
  blobToAttachment,
  dataUrlToAttachmentParts,
  imageFileToAttachment,
  isImagePath,
} from "@/apps/agent/lib/render/image-utils";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { AgentMicPermissionModal } from "@/apps/agent/components/modals/AgentMicPermissionModal";
import type { AttachedPromptChip } from "@/apps/agent/services/threads/thread-service";

interface AgentComposerProps {
  placeholder?: string;
  autoFocus?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (text: string, fileChips?: AttachedPromptChip[]) => void;
  onActionCommand?: (actionId: "compact" | "suggest") => void;
  sending?: boolean;
  onStop?: () => void;
  connectedTop?: boolean;
  /**
   * The conversation this composer writes into. Omit for the open chat; pass it
   * explicitly for a composer that isn't the main one (a chat docked in the side
   * panel). It selects which model the picker shows and which model's
   * capabilities gate the composer — both are per-conversation.
   */
  threadId?: string | null;
  /**
   * The project this composer's conversation belongs to. Omit to follow the
   * window's current scope (the main pane); pass it explicitly for a docked
   * chat, whose project is fixed at the moment it was docked and may not be the
   * one the window is scoped to now.
   *
   * It decides which project's files `@` offers and which project's rules and
   * skills `/` offers — both would silently be the wrong project's otherwise.
   */
  projectRoot?: string | null;
}

const MENTION_RE = /(^|[\s(])@([^\s@]{0,48})$/;
/** `/` directive trigger: at line start or after whitespace, word/dash query. */
const SLASH_RE = /(^|\s)\/([\w-]{0,48})$/;

/** Lucide-ish glyph per command kind (skills / rules / MCP). */
const COMMAND_ICON: Record<PromptCommandKind, "book" | "shield" | "plug" | "refine"> = {
  skill: "book",
  rule: "shield",
  mcp: "plug",
  action: "refine",
};

/** Raw SVG paths for each command kind — for the INLINE pill, which is built
 *  imperatively (not React), so it can't mount an <AgentIcon>. Mirrors the
 *  `book` / `shield` / `plug` glyphs. */
const COMMAND_ICON_PATHS: Record<PromptCommandKind, string> = {
  skill:
    '<path d="M5 4.5h9.5a2 2 0 0 1 2 2V19a1.5 1.5 0 0 0-1.5-1.5H5z"/><path d="M5 4.5A1.5 1.5 0 0 0 3.5 6v13A1.5 1.5 0 0 1 5 17.5"/><path d="M8 8.5h5.5"/><path d="M8 11.5h5.5"/>',
  rule:
    '<path d="M12 3 19 5.7v5.5c0 4.55-3 7.6-7 8.9-4-1.3-7-4.35-7-8.9V5.7z"/><path d="M9.1 11.9l2.1 2.1 3.7-3.9"/>',
  mcp:
    '<path d="M9 2.75v3.75M15 2.75v3.75"/><path d="M6.75 6.5h10.5v3.25a5.25 5.25 0 0 1-10.5 0z"/><path d="M12 15v6.25"/>',
  action:
    '<path d="m12 3 1.55 4.7L18.5 9.25l-4.95 1.55L12 15.5l-1.55-4.7L5.5 9.25l4.95-1.55z"/><path d="m19 14 .7 2.1 2.1.7-2.1.7L19 19.6l-.7-2.1-2.1-.7 2.1-.7z"/><path d="m5 15 .55 1.65 1.65.55-1.65.55L5 19.4l-.55-1.65-1.65-.55 1.65-.55z"/>',
};
function commandIconSvg(kind: PromptCommandKind): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${COMMAND_ICON_PATHS[kind]}</svg>`;
}

/** The `inspect` glyph, for the imperatively-built inline selection pill. */
/** The `@terminal` pill's mark: a prompt caret and a cursor bar in a frame. */
const TERMINAL_PILL_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 10l2.5 2-2.5 2"/><path d="M13 14h3.5"/></svg>';

const INSPECT_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 6.1l3.5 3.5"/><path d="M16.1 4.4a1.9 1.9 0 0 1 2.7 0l0.8 0.8a1.9 1.9 0 0 1 0 2.7L8.2 18.9l-4.2 1 1-4.2z"/></svg>';

/**
 * Build the inline pill for one inspector pick.
 *
 * Browser selections used to sit in their own row ABOVE the input while `@`
 * files and `/` directives lived inline — so the one attachment kind the user
 * did NOT type appeared furthest from where they were typing, detached from the
 * sentence it belonged to. This makes it the same object as the other two:
 * inline at the caret, deleted by Backspace, reconciled against the store.
 */
function buildSelectionPill(entry: SelectedEntry): HTMLSpanElement {
  const el = entry.element;
  const text = (el.text ?? "").trim();
  const pill = document.createElement("span");
  pill.className = "agw-pill-inline agw-pill-sel";
  pill.contentEditable = "false";
  pill.dataset.sel = entry.id;
  pill.title = [
    `selector: ${el.selector}`,
    `tag: <${el.tagName}>`,
    el.id ? `id: #${el.id}` : null,
    el.className ? `class: ${el.className}` : null,
    el.url ? `url: ${el.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const ico = document.createElement("span");
  ico.className = "agw-pill-cmd-ico";
  ico.innerHTML = INSPECT_ICON_SVG;
  pill.appendChild(ico);

  const tag = document.createElement("span");
  tag.className = "agw-sel-tag";
  tag.textContent = `<${el.tagName}>`;
  pill.appendChild(tag);

  if (text) {
    const label = document.createElement("span");
    label.className = "agw-sel-text";
    label.textContent = text.slice(0, 24);
    pill.appendChild(label);
  }
  return pill;
}

/** Serialize the contenteditable to plain text: pills → `@rel`, <br>/blocks → \n. */
function serializeEditor(root: HTMLElement, forSend = false): string {
  let out = "";
  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.ghost) return; // inline typing-assist ghost text — never sent
    if (el.dataset.cmd) {
      // Inline `/` command pill. Its EFFECT threads via the command store,
      // but its POSITION is part of the sentence — "no MX record for
      // [server-chip]; …" loses its object if the pill vanishes. On send it
      // serializes as `/title` so the model reads a coherent sentence and
      // the bubble can re-pill it in place. Draft/emptiness/refine reads
      // (`forSend` false) keep the old contract: a command-only composer is
      // still "empty".
      if (forSend && el.dataset.cmdTitle) out += `/${el.dataset.cmdTitle}`;
      return;
    }
    if (el.dataset.term) {
      // Inline `@terminal` pill. Serializes to the session id so the model can
      // hand it straight to `terminal_read` — a POINTER, not a paste. The
      // terminal's output can be tens of thousands of lines and changes while
      // the turn runs; the id stays true and the tool fetches what is needed.
      if (forSend) out += `@terminal:${el.dataset.term}`;
      return;
    }
    if (el.dataset.sel) {
      // Inline inspector pick. Same doctrine as the `/` pill above: its FULL
      // context threads via the selection store, but its POSITION is part of
      // the sentence — "make [pill] match the header" loses its object if the
      // pill vanishes. It used to serialize to NOTHING: the sent text kept a
      // hole where the pill sat, and the bubble hoisted the chip to the top.
      // On send it serializes as `@element:N`, so the model reads a coherent
      // sentence (the `<selected_elements>` block defines index N) and the
      // bubble re-pills it in place. N is read from the STORE at send time —
      // indices renumber when a pick is removed, so the DOM cannot cache one.
      if (forSend && el.dataset.sel) {
        const entry = useAgentSelectionStore
          .getState()
          .selected.find((e) => e.id === el.dataset.sel);
        if (entry) out += `@element:${entry.index}`;
      }
      return;
    }
    if (el.dataset.rel) {
      out += `@${el.dataset.rel}`;
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    // Block elements a browser may inject → newline-separated.
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

/** True for the four inline pill kinds: `@` file, `@terminal`, `/` directive, inspector pick. */
function isPill(node: ChildNode | null): node is HTMLElement {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  return !!(el.dataset.rel || el.dataset.cmd || el.dataset.sel || el.dataset.term);
}

/**
 * Pills that make the editor worth SENDING — each one carries a reference the
 * model receives even with no prose around it.
 */
const SENDABLE_PILLS = "[data-rel],[data-term]";
/**
 * Pills that are VISIBLE in the editor. A `/` directive shows but sends nothing
 * of its own, so it hides the placeholder without making the input sendable.
 *
 * Both selectors exist because these two questions were previously asked with
 * inline `querySelector` calls listing pill kinds by hand — and adding the
 * `@terminal` pill missed them, so picking a terminal left the placeholder
 * painted straight over the chip.
 */
const VISIBLE_PILLS = "[data-rel],[data-term],[data-cmd]";

/**
 * Delete the pill immediately before a collapsed caret. Returns whether one was
 * removed, so the caller can decide to preventDefault.
 *
 * Pills carry `user-select: none`, which makes Chromium refuse to extend a
 * selection over them — so the native "Backspace removes the whole widget"
 * behavior silently no-ops and the caret parks against the pill forever. That
 * is the "I had to Ctrl+A" symptom: every keystroke did nothing, with no
 * feedback explaining why. Deleting it ourselves restores the contract the
 * pills were designed around.
 */
function deletePillBeforeCaret(root: HTMLElement): boolean {
  const s = window.getSelection();
  if (!s || !s.isCollapsed || s.rangeCount === 0) return false;
  const { startContainer, startOffset } = s.getRangeAt(0);
  if (!root.contains(startContainer)) return false;

  let target: ChildNode | null = null;
  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    // Caret sits between children — the pill would be the one just before it.
    target = startOffset > 0 ? startContainer.childNodes[startOffset - 1] : null;
  } else if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
    // Caret at the very start of a text node (typically the emptied space that
    // followed the pill) — the pill is its previous sibling.
    target = startContainer.previousSibling;
  }
  if (!isPill(target)) return false;

  const range = document.createRange();
  range.setStartBefore(target);
  range.collapse(true);
  target.remove();
  s.removeAllRanges();
  s.addRange(range);
  return true;
}

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export const AgentComposer: React.FC<AgentComposerProps> = ({
  placeholder: placeholderProp,
  autoFocus = false,
  value,
  onValueChange,
  onSubmit,
  onActionCommand,
  sending = false,
  onStop,
  connectedTop = false,
  threadId,
  projectRoot,
}) => {
  // The conversation this composer belongs to. `undefined` (the common case)
  // means "the open chat"; an explicit value — including `null` for a draft —
  // is honoured as given, so a docked chat's composer never reads the main
  // pane's thread.
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const composerThreadId = threadId === undefined ? openThreadId : threadId;
  const pinnedModel = useAgentChatStore((s) =>
    pinnedThreadModel(s, composerThreadId),
  );
  const defaultModel = useSettingsStore((s) => s.selectedModel);
  const composerModel = pinnedModel ?? defaultModel;
  // Aurora Chat has no workspace, so the composer's offer of one has to go with
  // it: no `@` (it searches workspace files and open terminals) and no Browser
  // row (there are no browser tools on this side). The default placeholder goes
  // too — it advertised "@ for files" in a mode with no files to reach.
  const chatSurface = useSettingsStore((s) => s.auroraSurface) === "chat";
  const placeholder =
    placeholderProp ??
    (chatSurface ? "Message Aurora" : "Message Aurora — / for skills, @ for files");
  // Everything this composer stages before send — images, `/` directives — is
  // filed under its own key, so a second composer in the side panel can't
  // consume what was staged here (or vice versa).
  const stageKey = composerKey(composerThreadId);
  // The project whose files `@` searches and whose rules/skills `/` lists.
  const windowProjectRoot = useAgentChatStore((s) => s.projectRoot);
  const composerProjectRoot =
    projectRoot === undefined ? windowProjectRoot : projectRoot;

  const editorRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string>("");
  // `isEmpty` = nothing SENDABLE (drives the send button + submit). A `/` command
  // pill serializes to nothing, so a command-only composer is still "empty".
  // `blank` = nothing VISIBLE at all (drives the placeholder) — a command pill
  // IS visible, so it must hide the placeholder even though it isn't sendable.
  const [isEmpty, setIsEmpty] = useState(true);
  const [blank, setBlank] = useState(true);
  // Serialized length of the composer — gates the refine button (over-long
  // prompts, e.g. a pasted log, can't be refined).
  const [charLen, setCharLen] = useState(0);

  // Local, statistical typing help (autocorrect · completion · next-word),
  // gated per-feature by Preferences. Renders ghost text into this editor and
  // fixes words on boundaries; a no-op when every feature is off.
  const typing = useComposerTyping(editorRef);

  // Keep isEmpty / charLen / emitted value in sync after a programmatic edit
  // (refine apply/undo) WITHOUT the user-edit side effects of handleInput.
  const resyncComposer = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const hasSendablePill = !!el.querySelector(SENDABLE_PILLS);
    const hasVisiblePill = !!el.querySelector(VISIBLE_PILLS);
    const text = serializeEditor(el);
    const trimmed = text.trim();
    setIsEmpty(!hasSendablePill && trimmed === "");
    setBlank(!hasVisiblePill && trimmed === "");
    setCharLen(text.length);
    if (value !== undefined) {
      lastEmittedRef.current = text;
      onValueChange?.(text);
    }
  }, [value, onValueChange]);

  // Prompt refinement (optional, local llama.cpp GGUF) — the ✦ button.
  const refine = useComposerRefine(editorRef, serializeEditor, resyncComposer);

  // ── Image attachments + vision gate ────────────────────────────────
  // The composer is the SOLE gate: images only attach when the active model is
  // vision-capable. Non-vision models get a transient inline warning instead.
  const images = useAgentAttachmentStore((s) => composerImages(s, stageKey));
  const addImageAt = useAgentAttachmentStore((s) => s.add);
  const removeImageAt = useAgentAttachmentStore((s) => s.remove);
  const updateImageAt = useAgentAttachmentStore((s) => s.update);
  // Bound to THIS composer's staging key so the drop / paste / annotate paths
  // below read exactly as before, while writing into the right tray.
  const addImage = useCallback(
    (image: ImageAttachment) => addImageAt(stageKey, image),
    [addImageAt, stageKey],
  );
  const removeImage = useCallback(
    (id: string) => removeImageAt(stageKey, id),
    [removeImageAt, stageKey],
  );
  const updateImage = useCallback(
    (id: string, patch: Pick<ImageAttachment, "base64" | "mediaType">) =>
      updateImageAt(stageKey, id, patch),
    [updateImageAt, stageKey],
  );
  // Gated on THIS conversation's model, not the app-wide selection: with a
  // model per chat, the globally-selected one may be vision-capable while the
  // chat you're typing in is not — which would let an image attach to a model
  // that can never see it.
  const visionSupported = useSettingsStore(
    (s) => s.getModelFor(composerModel)?.supportsVision ?? false,
  );
  const [visionWarn, setVisionWarn] = useState<string | null>(null);
  const [annotateId, setAnnotateId] = useState<string | null>(null);

  const warnNoVision = () => {
    setVisionWarn(
      "This model can't see images. Switch to a vision model to attach images.",
    );
    window.setTimeout(() => setVisionWarn(null), 4000);
  };

  // Reveals the dock on the Browser tab — the `+` menu's route to picking an
  // element, since the inspector itself lives inside that panel.
  const openTab = useAgentWorkspaceStore((s) => s.openTab);
  // Elements picked with the Browser inspector — inline pills, attached on send.
  const selected = useAgentSelectionStore((s) => s.selected);
  const removeSelected = useAgentSelectionStore((s) => s.remove);

  // Picks arrive asynchronously from the inspector, so the store leads and the
  // editor mirrors it: add a pill for any entry that lacks one, drop any pill
  // whose entry is gone (cleared on send). The opposite direction — the user
  // backspacing a pill — is reconciled in `handleInput`, so this only ever
  // materializes what the store already holds and the two can't fight.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const live = new Set(selected.map((entry) => entry.id));
    const staged = new Set<string>();

    for (const pill of Array.from(el.querySelectorAll<HTMLElement>("[data-sel]"))) {
      const id = pill.dataset.sel ?? "";
      if (live.has(id)) staged.add(id);
      else pill.remove();
    }

    for (const entry of selected) {
      if (staged.has(entry.id)) continue;
      const pill = buildSelectionPill(entry);
      const space = document.createTextNode(" ");
      const s = window.getSelection();
      const range =
        s && s.rangeCount > 0 && s.anchorNode && el.contains(s.anchorNode)
          ? s.getRangeAt(0)
          : null;
      if (range) {
        range.insertNode(space);
        range.insertNode(pill);
        const after = document.createRange();
        after.setStartAfter(space);
        after.collapse(true);
        s?.removeAllRanges();
        s?.addRange(after);
      } else {
        // No caret in the composer — the user is still in the Browser panel.
        // Append rather than focusing, so picking a second element doesn't
        // yank focus out of the page they're picking from.
        el.appendChild(pill);
        el.appendChild(space);
      }
    }
  }, [selected]);

  // Composer layout prefs (Preferences settings).
  const modelSelectorPosition = useAgentThemeStore((s) => s.modelSelectorPosition);

  // ── @-mention state ────────────────────────────────────────────────
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [fileIndex, setFileIndex] = useState<MentionFile[]>([]);
  const [sel, setSel] = useState(0);

  const results = useMemo(
    () => (mention ? rankFiles(fileIndex, mention.query, 8) : []),
    [mention, fileIndex],
  );

  /**
   * Open terminals offered by the same `@` menu as files.
   *
   * Matched on the word "terminal" as well as each session's own title, so
   * both `@terminal` and `@pwsh` find them — the user thinks of it either as
   * "a terminal" or as the tab they named. Listed above files because when
   * the query matches a terminal it is almost never a file the user meant.
   */
  const terminalResults = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    const sessions = listTerminalSessions();
    if (!query) return sessions.slice(0, 5);
    return sessions
      .filter(
        (session) =>
          session.title.toLowerCase().includes(query) ||
          session.shell.toLowerCase().includes(query) ||
          "terminal".startsWith(query),
      )
      .slice(0, 5);
  }, [mention]);

  // ── /-command state (skills · rules · MCP — never files) ────────────
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [commandIndex, setCommandIndex] = useState<PromptCommand[]>([]);
  const [cmdSel, setCmdSel] = useState(0);
  const addCommandAt = useAgentCommandStore((s) => s.add);
  const removeCommandAt = useAgentCommandStore((s) => s.remove);
  const addCommand = useCallback(
    (command: PromptCommand) => addCommandAt(stageKey, command),
    [addCommandAt, stageKey],
  );
  const removeCommand = useCallback(
    (key: string) => removeCommandAt(stageKey, key),
    [removeCommandAt, stageKey],
  );

  const commandResults = useMemo(() => {
    if (!slash) return [];
    const available = onActionCommand
      ? commandIndex
      : commandIndex.filter((command) => command.kind !== "action");
    return rankCommands(available, slash.query, 8);
  }, [slash, commandIndex, onActionCommand]);

  const syncEmpty = () => {
    const el = editorRef.current;
    if (!el) return;
    // A file or terminal pill counts as content; a `/` command pill does NOT
    // (it serializes to nothing — it needs an accompanying message to send).
    // Inspector picks behave like `/` pills, and are checked at the render
    // site straight off the store (see the placeholder).
    const hasSendablePill = !!el.querySelector(SENDABLE_PILLS);
    const hasVisiblePill = !!el.querySelector(VISIBLE_PILLS);
    const text = serializeEditor(el).trim();
    setIsEmpty(!hasSendablePill && text === "");
    setBlank(!hasVisiblePill && text === "");
  };

  // The pickers re-run on every keyup and click — including the keyup of the
  // arrow key that just moved the highlight. Resetting the highlight there is
  // what made the selection snap straight back to the first row, so a refresh
  // that finds the SAME query must change nothing at all: same state object
  // (no re-ranking) and, above all, the same highlighted row.
  //
  // Only a query that actually changed produces a different result list, and
  // only then does starting from the top make sense.
  const mentionQueryRef = useRef<string | null>(null);
  const slashQueryRef = useRef<string | null>(null);

  // Both menus cap at 8 rows and scroll past ~280px, so the row the keyboard
  // just moved to can sit below the fold. Keyboard navigation has to be able
  // to see where it is without the mouse.
  const activeMentionRef = useRef<HTMLButtonElement>(null);
  const activeCommandRef = useRef<HTMLButtonElement>(null);

  const applyMentionQuery = (query: string | null) => {
    if (mentionQueryRef.current === query) return;
    mentionQueryRef.current = query;
    setMention(query === null ? null : { query });
    setSel(0);
  };

  const applySlashQuery = (query: string | null) => {
    if (slashQueryRef.current === query) return;
    slashQueryRef.current = query;
    setSlash(query === null ? null : { query });
    setCmdSel(0);
  };

  const refreshMention = () => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || !s.isCollapsed || s.rangeCount === 0) {
      applyMentionQuery(null);
      return;
    }
    const node = s.anchorNode;
    if (!node || !el.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      applyMentionQuery(null);
      return;
    }
    const before = (node.textContent ?? "").slice(0, s.anchorOffset);
    const m = before.match(MENTION_RE);
    if (!m) {
      applyMentionQuery(null);
      return;
    }
    applyMentionQuery(m[2]);
    if (fileIndex.length === 0) {
      void loadFileIndex(composerProjectRoot).then(setFileIndex);
    }
  };

  const refreshSlash = () => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || !s.isCollapsed || s.rangeCount === 0) {
      applySlashQuery(null);
      return;
    }
    const node = s.anchorNode;
    if (!node || !el.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      applySlashQuery(null);
      return;
    }
    const before = (node.textContent ?? "").slice(0, s.anchorOffset);
    const m = before.match(SLASH_RE);
    if (!m) {
      applySlashQuery(null);
      return;
    }
    applySlashQuery(m[2]);
    if (commandIndex.length === 0) {
      void loadPromptCommands(composerProjectRoot).then(setCommandIndex);
    }
  };

  // `block: "nearest"` scrolls only when the row is actually out of view, so a
  // highlight that is already visible never jolts the list.
  useEffect(() => {
    activeMentionRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  useEffect(() => {
    activeCommandRef.current?.scrollIntoView({ block: "nearest" });
  }, [cmdSel]);

  // The `@` and `/` triggers are mutually exclusive at the caret (only one regex
  // can match the text immediately before it); calling both just nulls the other.
  const refreshPickers = () => {
    refreshMention();
    refreshSlash();
  };

  const handleInput = () => {
    syncEmpty();
    const el = editorRef.current;
    if (el) {
      const text = serializeEditor(el);
      setCharLen(text.length);
      if (value !== undefined) {
        lastEmittedRef.current = text;
        onValueChange?.(text);
      }
      // Reconcile staged `/` commands with the inline pills still present —
      // deleting a command pill (backspace) drops it from the store.
      const domKeys = new Set(
        Array.from(el.querySelectorAll<HTMLElement>("[data-cmd]")).map((n) => n.dataset.cmd),
      );
      for (const c of composerCommands(useAgentCommandStore.getState(), stageKey)) {
        if (!domKeys.has(c.key)) removeCommand(c.key);
      }
      // Same contract for inspector picks: the pill IS the attachment, so
      // backspacing it must detach the element rather than leave it riding
      // along invisibly.
      const domSel = new Set(
        Array.from(el.querySelectorAll<HTMLElement>("[data-sel]")).map((n) => n.dataset.sel),
      );
      for (const entry of useAgentSelectionStore.getState().selected) {
        if (!domSel.has(entry.id)) removeSelected(entry.id);
      }
    }
    refreshPickers();
    // Suppress ghost text while an @/ picker is up — the menu owns the caret.
    if (mention || slash) typing.clearGhost();
    else typing.onInput();
    // A real edit ends the "just refined" undo affordance — but an input
    // event fired by the typing-assist's own mutation (applying or undoing
    // an autocorrect) is not the user editing.
    if (!typing.isProgrammaticEdit()) refine.onUserEdit();
  };

  /**
   * Insert an `@terminal` pill for one open session.
   *
   * Same anatomy as the file pill — replace the typed `@query`, drop in a
   * non-editable span, leave the caret after a trailing space — because it is
   * the same gesture and the caret rules (backspace deletes the widget whole)
   * are shared by `isPill`.
   */
  const insertTerminalPill = (session: TerminalSessionSummary) => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || s.rangeCount === 0) return;
    const node = s.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return;
    const offset = s.anchorOffset;
    const before = (node.textContent ?? "").slice(0, offset);
    const m = before.match(MENTION_RE);
    if (!m) return;
    const at = offset - (m[2].length + 1);

    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, offset);
    range.deleteContents();

    const pill = document.createElement("span");
    pill.className = "agw-pill-inline agw-pill-term";
    pill.contentEditable = "false";
    pill.dataset.term = session.id;
    pill.dataset.termTitle = session.title;
    pill.title = session.cwd ? `${session.title} — ${session.cwd}` : session.title;
    const ico = document.createElement("span");
    ico.className = "agw-pill-cmd-ico";
    ico.innerHTML = TERMINAL_PILL_ICON_SVG;
    pill.appendChild(ico);
    const label = document.createElement("span");
    label.textContent = session.title;
    pill.appendChild(label);

    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(pill);

    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    s.removeAllRanges();
    s.addRange(after);

    setMention(null);
    handleInput();
    el.focus();
  };

  const insertPill = (f: MentionFile) => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || s.rangeCount === 0) return;
    const node = s.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return;
    const offset = s.anchorOffset;
    const before = (node.textContent ?? "").slice(0, offset);
    const m = before.match(MENTION_RE);
    if (!m) return;
    const at = offset - (m[2].length + 1); // index of '@'

    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, offset);
    range.deleteContents();

    const pill = document.createElement("span");
    pill.className = "agw-pill-inline";
    pill.contentEditable = "false";
    pill.dataset.rel = f.rel;
    pill.dataset.path = f.path;
    try {
      const resolved = resolveExplorerIcon(
        { name: f.name, path: f.path, isFolder: false },
        useSettingsStore.getState().explorerIconPack,
      );
      if (resolved.src) {
        const img = document.createElement("img");
        img.src = resolved.src;
        img.alt = "";
        img.className = "agw-pill-ico";
        img.draggable = false;
        pill.appendChild(img);
      }
    } catch {
      /* icon optional */
    }
    {
      const label = document.createElement("span");
      label.textContent = f.name;
      pill.appendChild(label);
    }
    const space = document.createTextNode(" ");

    range.insertNode(space);
    range.insertNode(pill);

    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    s.removeAllRanges();
    s.addRange(after);

    setMention(null);
    handleInput();
    el.focus();
  };

  // Pick a `/` directive (skill / rule / MCP): drop an INLINE pill right where you
  // typed `/`, exactly like an `@`-mention — so it's part of the text you can type
  // around. Built-in action commands execute immediately instead of staging a
  // directive pill or sending a chat message.
  const pickCommand = (c: PromptCommand) => {
    if (c.kind === "action") {
      if (c.actionId) onActionCommand?.(c.actionId);
      const el = editorRef.current;
      const s = window.getSelection();
      if (el && s && s.rangeCount > 0) {
        const node = s.anchorNode;
        if (node && node.nodeType === Node.TEXT_NODE && el.contains(node)) {
          const offset = s.anchorOffset;
          const before = (node.textContent ?? "").slice(0, offset);
          const m = before.match(SLASH_RE);
          if (m) {
            const range = document.createRange();
            range.setStart(node, offset - (m[2].length + 1));
            range.setEnd(node, offset);
            range.deleteContents();
          }
        }
      }
      setSlash(null);
      handleInput();
      editorRef.current?.focus();
      return;
    }

    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || s.rangeCount === 0) return;
    const node = s.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return;
    const offset = s.anchorOffset;
    const before = (node.textContent ?? "").slice(0, offset);
    const m = before.match(SLASH_RE);
    if (!m) return;
    const at = offset - (m[2].length + 1); // index of '/'

    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, offset);
    range.deleteContents();

    const pill = document.createElement("span");
    pill.className = "agw-pill-inline agw-pill-cmd";
    pill.contentEditable = "false";
    pill.dataset.cmd = c.key;
    pill.dataset.cmdKind = c.kind;
    // What the pill serializes as on send (`/title`) — must match the chip
    // title recorded on the message, or the bubble can't re-pill it in place.
    pill.dataset.cmdTitle = c.title;
    pill.title = `${c.sourceLabel} · ${c.subtitle}`;
    const ico = document.createElement("span");
    ico.className = "agw-pill-cmd-ico";
    ico.innerHTML = commandIconSvg(c.kind);
    pill.appendChild(ico);
    const label = document.createElement("span");
    label.textContent = c.title;
    pill.appendChild(label);
    const space = document.createTextNode(" ");

    range.insertNode(space);
    range.insertNode(pill);

    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    s.removeAllRanges();
    s.addRange(after);

    addCommand(c);
    setSlash(null);
    handleInput();
    el.focus();
  };

  // Dropped file → the SAME pill the `@` picker builds, so a mention behaves
  // identically however it got here: `data-rel` is what serializes into the
  // message (`@src\foo.ts`), `data-path` is the absolute path the file chip and
  // "open in IDE" use. A file inside the project is written relative to it —
  // matching the picker — and anything outside keeps its absolute path, which is
  // the only form that can resolve.
  const insertPathPill = (absPath: string, isDir = false) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel0 = window.getSelection();
    if (!sel0 || sel0.rangeCount === 0 || !el.contains(sel0.anchorNode)) {
      placeCaretAtEnd(el);
    }
    const range = window.getSelection()?.getRangeAt(0);
    if (!range) return;
    const name = basenameOf(absPath);
    const rel = composerProjectRoot
      ? relativize(composerProjectRoot, absPath)
      : absPath;
    const pill = document.createElement("span");
    pill.className = "agw-pill-inline";
    pill.contentEditable = "false";
    pill.dataset.rel = rel;
    pill.dataset.path = absPath;
    // Marks the pill as a DIRECTORY. Read at submit so the model is told it was
    // handed a folder to look inside, not a file to read.
    if (isDir) pill.dataset.kind = "dir";
    try {
      const resolved = resolveExplorerIcon(
        { name, path: absPath, isFolder: isDir },
        useSettingsStore.getState().explorerIconPack,
      );
      if (resolved.src) {
        const img = document.createElement("img");
        img.src = resolved.src;
        img.alt = "";
        img.className = "agw-pill-ico";
        img.draggable = false;
        pill.appendChild(img);
      }
    } catch {
      /* icon optional */
    }
    const label = document.createElement("span");
    label.textContent = name;
    pill.appendChild(label);
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(pill);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    const sel2 = window.getSelection();
    sel2?.removeAllRanges();
    sel2?.addRange(after);
    handleInput();
    el.focus();
  };

  // Classify dropped/picked paths: folders → folder pill, images → attachment
  // (vision-gated), else a `@path` mention so the agent can read the file with
  // its tools. The Files panel says `isDir` at press time; an OS drop or picker
  // pick is a bare path string, so those are stat'ed — Tauri adds every
  // dropped/picked path to the fs scope, so the stat is always permitted.
  const handlePaths = (paths: string[], meta?: { isDir?: boolean }) => {
    void (async () => {
      for (const p of paths) {
        let isDir = meta?.isDir;
        if (isDir === undefined) {
          try {
            const { stat } = await import("@tauri-apps/plugin-fs");
            isDir = (await stat(p)).isDirectory;
          } catch {
            // Unreadable/missing → treat as a file; the pill still points at it.
            isDir = false;
          }
        }
        if (isDir) {
          insertPathPill(p, true);
        } else if (isImagePath(p)) {
          if (!visionSupported) {
            warnNoVision();
            continue;
          }
          void imageFileToAttachment(p)
            .then(addImage)
            .catch((err) => console.error("[agent-window] read dropped image failed:", err));
        } else {
          insertPathPill(p);
        }
      }
    })();
  };

  // Two transports, one destination: the OS file manager (Tauri drag-drop) and
  // this window's Files panel (pointer drag). Both land in `handlePaths`, so a
  // file behaves identically whichever side it was dragged from.
  const isOsDragOver = useAgentExternalDrop(composerRef, handlePaths);
  const isPathDragOver = useAgentPathDrop(composerRef, handlePaths);
  const isDragOver = isOsDragOver || isPathDragOver;

  // The `+` affordance: open the OS file picker and route the picks through the
  // same handler as a drag-drop — images attach (vision-gated), other files
  // become `@path` mentions the agent can read with its tools.
  const openFilePicker = async () => {
    try {
      const picked = await openFileDialog({ multiple: true });
      if (!picked) return;
      const paths = (Array.isArray(picked) ? picked : [picked]).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      if (paths.length > 0) handlePaths(paths);
    } catch (err) {
      console.error("[agent-window] file pick failed:", err);
    }
  };

  // External value (suggestion prefill) → write plain text into the editor.
  useEffect(() => {
    if (value === undefined) return;
    const el = editorRef.current;
    if (!el) return;
    const current = serializeEditor(el);
    if (value !== current && value !== lastEmittedRef.current) {
      el.textContent = value;
      lastEmittedRef.current = value;
      // Writing an external prop into the contenteditable is legitimate effect
      // work; the empty-state must then match the DOM we just wrote.
      syncEmpty();
      placeCaretAtEnd(el);
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);


  // After each turn the agent may have created/edited files — drop the index.
  const prevSending = useRef(sending);
  useEffect(() => {
    if (prevSending.current && !sending) {
      // THIS composer's project, not the window's: a docked chat's turn changed
      // files in its own project, and invalidating the window's cache would
      // both miss those and needlessly drop an unrelated project's index.
      const root = composerProjectRoot;
      // A finished turn may have changed files/commands — drop the cached
      // indexes so the next @/ picker reloads them fresh.
      invalidateFileIndex(root ?? undefined);
      invalidatePromptCommands(root);
      setFileIndex([]);
      setCommandIndex([]);
    }
    prevSending.current = sending;
    // `composerProjectRoot` only matters at the moment a turn settles, and the
    // `prevSending` guard means a change to it alone can't fire the body — but
    // it must be listed so the effect never closes over a stale project.
  }, [sending, composerProjectRoot]);

  // Speech → text: drop the transcript at the caret (or end), then resync.
  const insertTranscript = (text: string) => {
    const el = editorRef.current;
    if (!el || !text) return;
    el.focus();
    const seln = window.getSelection();
    if (!seln || seln.rangeCount === 0 || !el.contains(seln.anchorNode)) {
      placeCaretAtEnd(el);
    }
    const existing = el.textContent ?? "";
    const needsSpace = existing.length > 0 && !/\s$/.test(existing);
    document.execCommand("insertText", false, (needsSpace ? " " : "") + text);
    handleInput();
  };

  /**
   * Open the `@` or `/` picker from the `+` menu by TYPING its character, not
   * by calling into the picker state.
   *
   * Both pickers key off what sits before the caret (MENTION_RE / SLASH_RE), so
   * inserting the character is the whole gesture: detection, ranking, the
   * escape hatch of deleting it again, and every rule about pills and caret
   * placement all come along unchanged. Driving `setMention`/`setSlash`
   * directly would open a menu with no trigger character behind it — the first
   * keystroke would close it again, and picking a row would splice a pill into
   * text that never asked for one.
   *
   * `insertTranscript` already inserts at the caret with a leading space when
   * one is needed, which is exactly what both regexes require (line start or
   * whitespace before the character).
   */
  const openPicker = (trigger: "@" | "/") => {
    editorRef.current?.focus();
    insertTranscript(trigger);
  };

  const plusItems = useMemo<PlusMenuItem[]>(
    () =>
      [
        {
          // Attaching from this computer is an UPLOAD, not a workspace read, so
          // it survives into chat — and it is how a picture reaches a chat.
          id: "files",
          label: "Files & images",
          hint: "Pick from this computer",
          icon: "upload" as const,
          run: () => void openFilePicker(),
        },
        // `@` searches the workspace and the open terminals. Chat has neither.
        ...(chatSurface
          ? []
          : [
              {
                id: "mention",
                label: "Mention",
                hint: "A workspace file or an open terminal",
                icon: "at" as const,
                run: () => openPicker("@"),
              },
            ]),
        {
          id: "actions",
          label: "Actions",
          hint: chatSurface ? "Skills and MCP commands" : "Skills, rules and MCP commands",
          icon: "slash" as const,
          run: () => openPicker("/"),
        },
        // Chat mode registers no browser tools, so the panel would open onto a
        // page nothing can act on.
        ...(chatSurface
          ? []
          : [
              {
                id: "browser",
                label: "Browser",
                hint: "Open the browser panel to pick an element",
                icon: "browser" as const,
                run: () => openTab("browser"),
              },
            ]),
      ] satisfies PlusMenuItem[],
    // openFilePicker / openPicker close over refs and stable store actions, and
    // are redefined every render; listing them would rebuild this list on each
    // keystroke for no behavioural difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTab, chatSurface],
  );
  const {
    speechEnabled,
    isRecording: micRecording,
    isTranscribing: micTranscribing,
    notice: micNotice,
    toggle: micToggle,
    visualizerRef: micWaveRef,
    permissionOpen: micPermissionOpen,
    confirmPermission: micConfirmPermission,
    dismissPermission: micDismissPermission,
  } = useAgentSpeech(insertTranscript);

  const submit = () => {
    // NB: we intentionally do NOT bail when `sending`. A submit mid-turn is a
    // mid-turn injection — the send pipeline routes it to the runtime's queue
    // (drained at the next tool-result boundary) instead of starting a new
    // turn. The Stop button stays the primary action; Enter queues.
    const el = editorRef.current;
    if (!el) return;
    typing.clearGhost();
    // The send gate reads the DRAFT serialization (command pills excluded):
    // a command pill still needs an accompanying message, same as before.
    // What actually sends is the forSend form, with `/title` tokens in place.
    const bare = serializeEditor(el).trim();
    const text = serializeEditor(el, true).trim();
    if (!bare || !text || !onSubmit) return;
    const fileChips: AttachedPromptChip[] = Array.from(
      el.querySelectorAll<HTMLElement>("[data-rel]"),
    ).map((pill) => ({
      kind: pill.dataset.kind === "dir" ? "folder" : "file",
      title: pill.textContent?.trim() || basenameOf(pill.dataset.rel ?? ""),
      value: pill.dataset.rel ?? "",
      path: pill.dataset.path ?? pill.dataset.rel ?? "",
    }));
    // A dragged FOLDER is a different instruction from a file mention: the path
    // alone reads as something to open, and a model that tries to read a
    // directory just burns a failed tool call. One line names what it is and
    // what was wanted, appended once no matter how many folders came in — the
    // user sees exactly what the model was told, because it is the same text.
    const terminalChips: AttachedPromptChip[] = Array.from(
      el.querySelectorAll<HTMLElement>("[data-term]"),
    ).map((pill) => ({
      kind: "terminal" as const,
      title: pill.dataset.termTitle ?? "terminal",
      value: pill.dataset.term ?? "",
    }));
    const folders = fileChips.filter((chip) => chip.kind === "folder");
    const outgoing =
      folders.length === 0
        ? text
        : `${text}\n\n(${folders.length === 1 ? "Folder" : "Folders"} dragged in by the user: ` +
          `${folders.map((chip) => chip.value).join(", ")} — look inside ` +
          `${folders.length === 1 ? "it" : "them"}.)`;
    onSubmit(outgoing, [...fileChips, ...terminalChips]);
    el.innerHTML = "";
    lastEmittedRef.current = "";
    setIsEmpty(true);
    setBlank(true);
    setCharLen(0);
    setMention(null);
    setSlash(null);
    onValueChange?.("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Typing-assist first: → accepts ghost text, Backspace undoes a correction.
    // Only claims the key when it actually acts; otherwise falls through.
    if (typing.onKeyDown(e)) return;

    // Backspace against a pill. Runs after typing-assist (which owns Backspace
    // for undoing a correction) and only for a bare Backspace on a collapsed
    // caret, so Ctrl/Alt shortcuts and range deletions keep native behavior.
    if (
      e.key === "Backspace" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      editorRef.current &&
      deletePillBeforeCaret(editorRef.current)
    ) {
      e.preventDefault();
      // Reconciles the `/` command and inspector-pick stores against the pills
      // that are actually left, so the deleted one detaches from the turn.
      handleInput();
      return;
    }
    if (slash && commandResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdSel((s) => Math.min(s + 1, commandResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdSel((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        // The list can shrink under a highlight that was valid a moment ago
        // (the command index loads asynchronously); fall back rather than
        // handing `undefined` to the picker.
        pickCommand(commandResults[cmdSel] ?? commandResults[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Closes without touching `slashQueryRef`, so the keyup that follows
        // sees an unchanged query and leaves it closed. Dismissal holds until
        // the text actually changes.
        setSlash(null);
        return;
      }
    }
    if (mention && results.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertPill(results[sel] ?? results[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // See the `/` picker above: the ref is left alone so the dismissal
        // survives the keyup and holds until the query changes.
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "\n");
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // Paste: an image goes through the vision gate → attachment; otherwise plain
  // text only (keeps the editor to text nodes + pills).
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
    const imageItem = items.find(
      (it) => it.kind === "file" && it.type.startsWith("image/"),
    );
    if (imageItem) {
      e.preventDefault();
      if (!visionSupported) {
        warnNoVision();
        return;
      }
      const file = imageItem.getAsFile();
      if (file) {
        void blobToAttachment(file, file.name || "pasted-image.png")
          .then(addImage)
          .catch((err) => console.error("[agent-window] paste image failed:", err));
      }
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  };

  const annotateImg = images.find((i) => i.id === annotateId) ?? null;

  return (
    <div
      ref={composerRef}
      className={`agw-composer z-10 w-full max-w-3xl mx-auto relative${
        isDragOver ? " agw-composer-drop" : ""
      }`}
    >
      {/* @-mention file picker — floats above the input. */}
      <AnimatePresence>
        {mention && (results.length > 0 || terminalResults.length > 0) && (
          <ComposerMenu resetKey={mention.query}>
            {terminalResults.map((session) => (
              <button
                key={`term-${session.id}`}
                type="button"
                className="agw-mention-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertTerminalPill(session);
                }}
              >
                <AgentIcon name="terminal" size={13} className="agw-file-ico" />
                <span className="agw-mention-name">{session.title}</span>
                <span className="agw-mention-path">
                  {session.running ? session.cwd ?? session.shell : "exited"}
                </span>
              </button>
            ))}
            {results.map((f, i) => (
              <button
                key={f.path}
                ref={i === sel ? activeMentionRef : undefined}
                type="button"
                className="agw-mention-item"
                data-active={i === sel || undefined}
                // `onMouseMove`, not `onMouseEnter`: scrolling the list under a
                // stationary cursor fires enter and would drag the highlight
                // back to whatever row slid beneath the pointer.
                onMouseMove={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertPill(f);
                }}
              >
                <FileIcon name={f.name} path={f.path} className="agw-file-ico" />
                <span className="agw-mention-name">{f.name}</span>
                <span className="agw-mention-path">{f.rel}</span>
              </button>
            ))}
          </ComposerMenu>
        )}
      </AnimatePresence>

      {/* /-command picker (skills · rules · MCP) — floats above the input. */}
      <AnimatePresence>
        {slash && commandResults.length > 0 && (
          <ComposerMenu resetKey={slash.query}>
            {commandResults.map((c, i) => (
              <button
                key={c.key}
                ref={i === cmdSel ? activeCommandRef : undefined}
                type="button"
                className="agw-mention-item"
                data-active={i === cmdSel || undefined}
                // See the mention list: movement, not mere entry, changes the
                // highlight, so keyboard navigation is never undone by a
                // cursor that simply happens to be resting over the menu.
                onMouseMove={() => setCmdSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(c);
                }}
              >
                <AgentIcon
                  name={COMMAND_ICON[c.kind]}
                  size={14}
                  className="agw-file-ico"
                />
                <span className="agw-mention-name">{c.title}</span>
                <span className="agw-cmd-source">{c.sourceLabel}</span>
                <span className="agw-mention-path">{c.subtitle}</span>
              </button>
            ))}
          </ComposerMenu>
        )}
      </AnimatePresence>

      <div
        className={`agw-composer-surface cursor-text relative ${
          /* Radius — sharper, closer to Codex. Change 16px to taste. */
          connectedTop ? "rounded-t-none rounded-b-[16px]" : "rounded-[16px]"
        }`}
        style={{
          background: "var(--agw-composer-surface)",
          border: "1px solid var(--agw-border-strong)",
          ...(connectedTop ? { borderTop: "none" } : {}),
        }}
        onClick={() => editorRef.current?.focus()}
      >
        {/* Top band — a SINGLE layer that only exists when the selector is
            top-positioned (mode now lives inside the picker, so there's nothing
            else to reserve space for). When the selector is at the bottom, no
            band renders and the editor gets comfortable top padding instead —
            so the placeholder sits near the top like Codex, no empty strip. */}
        {modelSelectorPosition === "top" && (
          <div className="agw-composer-band">
            <ModelSelector align="left" streaming={sending} threadId={composerThreadId} />
          </div>
        )}

        {/* `/` directives and Browser inspector picks both live INLINE in the
            input as pills (see `pickCommand` and the selection-sync effect),
            exactly like `@`-mentions — no separate chip rows. */}

        {/* Staged image attachments + the vision-gate warning. */}
        {(images.length > 0 || visionWarn) && (
          <div className="agw-attach-row" onClick={(e) => e.stopPropagation()}>
            {images.map((img) => (
              <div
                key={img.id}
                className="agw-attach-card"
                title={`${img.name} — click to annotate`}
                onClick={() => setAnnotateId(img.id)}
              >
                <img
                  src={attachmentDataUrl(img)}
                  alt={img.name}
                  className="agw-attach-thumb"
                  draggable={false}
                />
                <button
                  type="button"
                  className="agw-attach-x"
                  title="Remove image"
                  aria-label="Remove image"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    removeImage(img.id);
                  }}
                >
                  <AgentIcon name="close" size={9} />
                </button>
              </div>
            ))}
            {visionWarn && <span className="agw-attach-warn">{visionWarn}</span>}
          </div>
        )}

        {/* Contenteditable input + placeholder overlay. `data-top-selector`
            tells the CSS the band above already provides the top spacing (small
            padding); without it the editor takes comfortable top padding so the
            placeholder sits near the box top, Codex-style. */}
        <div
          className="agw-ce-wrap"
          data-top-selector={modelSelectorPosition === "top" || undefined}
        >
          {/* `blank` is measured from the editor DOM, which the async pill sync
              writes to outside React — so a pick that lands while the composer
              is untouched is checked against the store directly rather than
              waiting for an input event that never comes. */}
          {blank && selected.length === 0 && (
            <div className="agw-ce-placeholder">{placeholder}</div>
          )}
          <div
            ref={editorRef}
            className="agw-ce agw-scroll"
            contentEditable
            role="textbox"
            aria-multiline="true"
            spellCheck
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyUp={refreshPickers}
            onClick={refreshPickers}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => {
              typing.clearGhost();
              window.setTimeout(() => {
                // Clear the remembered queries too: coming back to the same
                // caret should reopen the picker, unlike an Escape dismissal.
                mentionQueryRef.current = null;
                slashQueryRef.current = null;
                setMention(null);
                setSlash(null);
              }, 120);
            }}
          />
        </div>

        {/* Bottom action row — attach (left) · reasoning + speech + send (right). */}
        <div className="agw-composer-actions-row">
          <ComposerPlusMenu items={plusItems} />
          <div className="agw-composer-actions">
          {modelSelectorPosition === "bottom" && (
            <ModelSelector align="right" streaming={sending} threadId={composerThreadId} />
          )}
          {refine.ready && (
            <button
              type="button"
              className="agw-icon-btn"
              data-refining={refine.phase === "refining" || undefined}
              disabled={
                refine.phase === "idle" && (isEmpty || charLen > MAX_REFINE_CHARS)
              }
              title={
                refine.phase === "refining"
                  ? "Stop refining"
                  : refine.phase === "refined"
                    ? "Undo refine"
                    : charLen > MAX_REFINE_CHARS
                      ? `Prompt too long to refine (max ${MAX_REFINE_CHARS.toLocaleString()} characters)`
                      : "Refine prompt"
              }
              aria-label={
                refine.phase === "refined" ? "Undo refine" : "Refine prompt"
              }
              onClick={(e) => {
                e.stopPropagation();
                if (refine.phase === "refining") refine.cancel();
                else if (refine.phase === "refined") refine.undo();
                else refine.run();
              }}
            >
              {refine.phase === "refining" ? (
                <span className="agw-rail-spin" aria-hidden />
              ) : refine.phase === "refined" ? (
                <AgentIcon name="reset" size={15} />
              ) : (
                <AgentIcon name="refine" size={16} />
              )}
            </button>
          )}
          {speechEnabled && (
            <div className="agw-composer-speech" onClick={(e) => e.stopPropagation()}>
              {micRecording && (
                <div ref={micWaveRef} className="agw-mic-wave" aria-hidden />
              )}
              <button
                type="button"
                className="agw-icon-btn"
                data-recording={micRecording || undefined}
                disabled={micTranscribing}
                title={
                  micNotice?.text ||
                  (micTranscribing
                    ? "Transcribing…"
                    : micRecording
                      ? "Stop recording"
                      : "Speak")
                }
                aria-label={micRecording ? "Stop recording" : "Start speech input"}
                onClick={(e) => {
                  e.stopPropagation();
                  micToggle();
                }}
              >
                {micTranscribing ? (
                  <span className="agw-rail-spin" aria-hidden />
                ) : micRecording ? (
                  <AgentIcon name="stop" size={13} />
                ) : (
                  <AgentIcon name="mic" size={15} />
                )}
              </button>
            </div>
          )}
          {sending && isEmpty ? (
            // Streaming with an empty composer → the button stops the turn. At
            // rest it shows the same pulsing dot-matrix the titlebar uses ("the
            // model is working"); on hover it flips to the white stop disc so
            // the click target reads clearly as Stop. The whole button is the
            // stop target in both states.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStop?.();
              }}
              className="agw-send agw-send-stream"
              title="Stop generating"
              aria-label="Stop generating"
            >
              <span className="agw-send-stream-matrix" aria-hidden="true">
                <StreamingDotMatrix size={22} />
              </span>
              {/* The `stop` glyph is a rect filling only ~42% of its 24-unit box,
                  so the visible square ≈ size × 0.42. size 24 → ~10px square in
                  the 34px disc (~30%), the standard stop-button proportion. */}
              <span className="agw-send-stream-stop" aria-hidden="true">
                <AgentIcon name="stop" size={24} />
              </span>
            </button>
          ) : (
            // Otherwise it's the send disc. Mid-stream, typing flips Stop back to
            // Send so the message can be queued (the pipeline routes a mid-turn
            // submit into the runtime's queue, drained at the next tool boundary).
            <button
              type="button"
              disabled={isEmpty}
              onClick={(e) => {
                e.stopPropagation();
                submit();
              }}
              className="agw-send"
              title={sending ? "Queue message" : "Send message"}
            >
              {/* A dark glyph on a light disc reads optically THINNER than the
                  reverse, so this carries a touch more weight than the 2.3 the
                  icon row uses. */}
              <AgentIcon name="send" size={17} strokeWidth={2.6} />
            </button>
          )}
          </div>
        </div>
      </div>

      {/* The strip under the composer. It still carries the transient microphone
          and prompt-refine notices inline (a tooltip alone reads as a dead
          button) — warnings soft yellow, errors red, both auto-dismissing after
          ~5s (see useAgentSpeech) — but it is now the rail that also hosts
          ambient state as chips, so nothing has to push the transcript down to
          be seen. See ComposerRail for what belongs here and what does not. */}
      <ComposerRail
        threadId={composerThreadId}
        notice={
          micNotice
            ? {
                text: `Microphone: ${micNotice.text}`,
                tone: micNotice.severity === "warning" ? "warning" : "error",
              }
            : refine.notice
              ? { text: refine.notice, tone: "warning" }
              : null
        }
      />

      {/* Annotate a staged attachment — flattened back onto the card on Done. */}
      <AgentImageModal
        open={annotateId !== null}
        mode="annotate"
        src={annotateImg ? attachmentDataUrl(annotateImg) : null}
        onClose={() => setAnnotateId(null)}
        onSave={(dataUrl) => {
          if (!annotateId) return;
          // Annotating re-flattens the picture, so it goes back through the same
          // bound + JPEG encode a paste does — otherwise drawing one arrow on a
          // staged image silently restored the full-size PNG.
          void dataUrlToAttachmentParts(dataUrl).then(({ base64, mediaType }) => {
            if (base64) updateImage(annotateId, { base64, mediaType });
          });
        }}
      />

      {/* Our own microphone gate — the only mic prompt the user sees (the
          native WebView prompt is suppressed for the agent window). Mounted
          only while open so its "remember" toggle starts fresh each time. */}
      {micPermissionOpen && (
        <AgentMicPermissionModal
          onAllow={micConfirmPermission}
          onDismiss={micDismissPermission}
        />
      )}
    </div>
  );
};
