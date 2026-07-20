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
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { openFileDialog } from "../../lib/tauri";
import { FileIcon } from "../../components/explorer/FileIcons";
import { resolveExplorerIcon } from "../../lib/icon-registry";
import { useSettingsStore } from "../../store/useSettingsStore";
import { ModelSelector } from "./ModelSelector";
import {
  invalidateFileIndex,
  loadFileIndex,
  rankFiles,
  type MentionFile,
} from "../adapters/file-index";
import {
  invalidatePromptCommands,
  loadPromptCommands,
  rankCommands,
  type PromptCommand,
  type PromptCommandKind,
} from "../adapters/prompt-commands";
import { useAgentCommandStore } from "../store/useAgentCommandStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentSelectionStore } from "../store/useAgentSelectionStore";
import { useAgentThemeStore } from "../store/useAgentThemeStore";
import { useAgentSpeech } from "../hooks/useAgentSpeech";
import { useAgentExternalDrop } from "../hooks/useAgentExternalDrop";
import { useComposerTyping } from "../hooks/useComposerTyping";
import { useComposerRefine } from "../hooks/useComposerRefine";
import { MAX_REFINE_CHARS } from "../adapters/prompt-refine";
import {
  attachmentDataUrl,
  useAgentAttachmentStore,
} from "../store/useAgentAttachmentStore";
import {
  basenameOf,
  blobToAttachment,
  dataUrlToParts,
  imageFileToAttachment,
  isImagePath,
} from "../lib/image-utils";
import { AgentImageModal } from "./AgentImageModal";
import { AgentMicPermissionModal } from "./AgentMicPermissionModal";
import type { AttachedPromptChip } from "../../services/thread-service";

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

/** Serialize the contenteditable to plain text: pills → `@rel`, <br>/blocks → \n. */
function serializeEditor(root: HTMLElement): string {
  let out = "";
  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.ghost) return; // inline typing-assist ghost text — never sent
    if (el.dataset.cmd) return; // inline `/` command pill — threaded via the store, not the text
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

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export const AgentComposer: React.FC<AgentComposerProps> = ({
  placeholder = "Message Aurora — / for skills, @ for files",
  autoFocus = false,
  value,
  onValueChange,
  onSubmit,
  onActionCommand,
  sending = false,
  onStop,
  connectedTop = false,
}) => {
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
    const hasFilePill = !!el.querySelector("[data-rel]");
    const hasCmdPill = !!el.querySelector("[data-cmd]");
    const text = serializeEditor(el);
    const trimmed = text.trim();
    setIsEmpty(!hasFilePill && trimmed === "");
    setBlank(!hasFilePill && !hasCmdPill && trimmed === "");
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
  const images = useAgentAttachmentStore((s) => s.images);
  const addImage = useAgentAttachmentStore((s) => s.add);
  const removeImage = useAgentAttachmentStore((s) => s.remove);
  const updateImage = useAgentAttachmentStore((s) => s.update);
  const visionSupported = useSettingsStore(
    (s) => s.getResolvedActiveModel()?.supportsVision ?? false,
  );
  const [visionWarn, setVisionWarn] = useState<string | null>(null);
  const [annotateId, setAnnotateId] = useState<string | null>(null);

  const warnNoVision = () => {
    setVisionWarn(
      "This model can't see images. Switch to a vision model to attach images.",
    );
    window.setTimeout(() => setVisionWarn(null), 4000);
  };

  // Elements picked with the Browser inspector — shown as chips, attached on send.
  const selected = useAgentSelectionStore((s) => s.selected);
  const removeSelected = useAgentSelectionStore((s) => s.remove);

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

  // ── /-command state (skills · rules · MCP — never files) ────────────
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [commandIndex, setCommandIndex] = useState<PromptCommand[]>([]);
  const [cmdSel, setCmdSel] = useState(0);
  const addCommand = useAgentCommandStore((s) => s.add);
  const removeCommand = useAgentCommandStore((s) => s.remove);

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
    // A file `@`-pill counts as content; a `/` command pill does NOT (it
    // serializes to nothing — it needs an accompanying message to send).
    const hasFilePill = !!el.querySelector("[data-rel]");
    const hasCmdPill = !!el.querySelector("[data-cmd]");
    const text = serializeEditor(el).trim();
    setIsEmpty(!hasFilePill && text === "");
    setBlank(!hasFilePill && !hasCmdPill && text === "");
  };

  const refreshMention = () => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || !s.isCollapsed || s.rangeCount === 0) {
      setMention(null);
      return;
    }
    const node = s.anchorNode;
    if (!node || !el.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      setMention(null);
      return;
    }
    const before = (node.textContent ?? "").slice(0, s.anchorOffset);
    const m = before.match(MENTION_RE);
    if (!m) {
      setMention(null);
      return;
    }
    setMention({ query: m[2] });
    setSel(0);
    if (fileIndex.length === 0) {
      void loadFileIndex(useAgentChatStore.getState().projectRoot).then(setFileIndex);
    }
  };

  const refreshSlash = () => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || !s.isCollapsed || s.rangeCount === 0) {
      setSlash(null);
      return;
    }
    const node = s.anchorNode;
    if (!node || !el.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      setSlash(null);
      return;
    }
    const before = (node.textContent ?? "").slice(0, s.anchorOffset);
    const m = before.match(SLASH_RE);
    if (!m) {
      setSlash(null);
      return;
    }
    setSlash({ query: m[2] });
    setCmdSel(0);
    if (commandIndex.length === 0) {
      void loadPromptCommands(useAgentChatStore.getState().projectRoot).then(
        setCommandIndex,
      );
    }
  };

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
      for (const c of useAgentCommandStore.getState().commands) {
        if (!domKeys.has(c.key)) removeCommand(c.key);
      }
    }
    refreshPickers();
    // Suppress ghost text while an @/ picker is up — the menu owns the caret.
    if (mention || slash) typing.clearGhost();
    else typing.onInput();
    // A real edit ends the "just refined" undo affordance.
    refine.onUserEdit();
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

  // Drag-from-Explorer: insert a pill carrying the ABSOLUTE path so it
  // serializes to `@<abs path>` — the agent then reads it with its file tools.
  const insertPathPill = (absPath: string) => {
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
    const pill = document.createElement("span");
    pill.className = "agw-pill-inline";
    pill.contentEditable = "false";
    pill.dataset.rel = absPath;
    pill.dataset.path = absPath;
    try {
      const resolved = resolveExplorerIcon(
        { name, path: absPath, isFolder: false },
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

  // Classify OS-dropped paths: images → attachment (vision-gated), else a
  // `@path` mention so the agent can read the file with its tools.
  const handlePaths = (paths: string[]) => {
    for (const p of paths) {
      if (isImagePath(p)) {
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
  };

  const isDragOver = useAgentExternalDrop(composerRef, handlePaths);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- external DOM sync
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
      const root = useAgentChatStore.getState().projectRoot;
      // A finished turn may have changed files/commands — drop the cached
      // indexes so the next @/ picker reloads them fresh.
      invalidateFileIndex(root ?? undefined);
      invalidatePromptCommands(root);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset caches on turn boundary
      setFileIndex([]);
      setCommandIndex([]);
    }
    prevSending.current = sending;
  }, [sending]);

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
    const text = serializeEditor(el).trim();
    if (!text || !onSubmit) return;
    const fileChips: AttachedPromptChip[] = Array.from(
      el.querySelectorAll<HTMLElement>("[data-rel]"),
    ).map((pill) => ({
      kind: "file",
      title: pill.textContent?.trim() || basenameOf(pill.dataset.rel ?? ""),
      value: pill.dataset.rel ?? "",
      path: pill.dataset.path ?? pill.dataset.rel ?? "",
    }));
    onSubmit(text, fileChips);
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
        pickCommand(commandResults[cmdSel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
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
        insertPill(results[sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
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
      className={`agw-composer z-10 w-full max-w-4xl mx-auto relative${
        isDragOver ? " agw-composer-drop" : ""
      }`}
    >
      {/* @-mention file picker — floats above the input. */}
      <AnimatePresence>
        {mention && results.length > 0 && (
          <motion.div
            className="agw-menu agw-mention"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 32, mass: 0.7 }}
          >
            {results.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className="agw-mention-item"
                data-active={i === sel || undefined}
                onMouseEnter={() => setSel(i)}
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
          </motion.div>
        )}
      </AnimatePresence>

      {/* /-command picker (skills · rules · MCP) — floats above the input. */}
      <AnimatePresence>
        {slash && commandResults.length > 0 && (
          <motion.div
            className="agw-menu agw-mention"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 32, mass: 0.7 }}
          >
            {commandResults.map((c, i) => (
              <button
                key={c.key}
                type="button"
                className="agw-mention-item"
                data-active={i === cmdSel || undefined}
                onMouseEnter={() => setCmdSel(i)}
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
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`cursor-text relative ${
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
          <div className="agw-composer-band flex items-center gap-2 px-2.5 pt-2 pb-1.5">
            <ModelSelector align="left" streaming={sending} />
          </div>
        )}

        {/* Inspector picks — "Selected" chips, attached to the next turn. */}
        {selected.length > 0 && (
          <div className="agw-sel-row" onClick={(e) => e.stopPropagation()}>
            {selected.map((entry) => {
              const el = entry.element;
              const text = (el.text ?? "").trim();
              const tip = [
                `selector: ${el.selector}`,
                `tag: <${el.tagName}>`,
                el.id ? `id: #${el.id}` : null,
                el.className ? `class: ${el.className}` : null,
                el.url ? `url: ${el.url}` : null,
              ]
                .filter(Boolean)
                .join("\n");
              return (
                <span key={entry.id} className="agw-sel-chip" title={tip}>
                  <AgentIcon name="inspect" size={11} />
                  <span className="agw-sel-tag">{`<${el.tagName}>`}</span>
                  {text && <span className="agw-sel-text">{text.slice(0, 24)}</span>}
                  <button
                    type="button"
                    className="agw-sel-x"
                    title="Remove selection"
                    aria-label="Remove selection"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      removeSelected(entry.id);
                    }}
                  >
                    <AgentIcon name="close" size={9} />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* `/` directives now live INLINE in the input as pills (see
            `pickCommand`), exactly like `@`-mentions — no separate chip row. */}

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
          className="agw-ce-wrap px-3 pb-2 relative"
          data-top-selector={modelSelectorPosition === "top" || undefined}
        >
          {blank && <div className="agw-ce-placeholder">{placeholder}</div>}
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
                setMention(null);
                setSlash(null);
              }, 120);
            }}
          />
        </div>

        {/* Bottom action row — attach (left) · reasoning + speech + send (right). */}
        <div className="agw-composer-actions-row px-2 pb-1.5 flex items-center justify-between gap-1.5">
          <button
            type="button"
            className="agw-icon-btn"
            title="Attach a file"
            aria-label="Attach a file"
            onClick={(e) => {
              e.stopPropagation();
              void openFilePicker();
            }}
          >
            <AgentIcon name="plus" size={17} />
          </button>
          <div className="agw-composer-actions flex items-center gap-1.5">
          {modelSelectorPosition === "bottom" && (
            <ModelSelector align="right" streaming={sending} />
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
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
            // Streaming with an empty composer → the button stops the turn.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStop?.();
              }}
              className="agw-send"
              style={{ background: "var(--agw-accent)", color: "var(--agw-on-accent)" }}
              title="Stop generating"
            >
              <AgentIcon name="stop" size={16} />
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
              style={{
                background: isEmpty ? "var(--agw-control-muted)" : "var(--agw-accent)",
                color: isEmpty ? "var(--agw-text-subtle)" : "var(--agw-on-accent)",
                cursor: isEmpty ? "not-allowed" : "pointer",
              }}
              title={sending ? "Queue message" : "Send message"}
            >
              <AgentIcon name="send" size={15} strokeWidth={isEmpty ? 2 : 2.3} />
            </button>
          )}
          </div>
        </div>
      </div>

      {/* Footer — surfaces a transient microphone notice inline (a tooltip alone
          reads as a dead button). Warnings show soft yellow, errors red; both
          auto-dismiss after ~5s (see useAgentSpeech), then the default hint
          returns. */}
      <div className="mt-3 text-center">
        {micNotice ? (
          <p
            className="text-[11px]"
            style={{
              color:
                micNotice.severity === "warning"
                  ? "var(--agw-warning)"
                  : "var(--agw-removed)",
            }}
          >
            Microphone: {micNotice.text}
          </p>
        ) : refine.notice ? (
          <p className="text-[11px]" style={{ color: "var(--agw-warning)" }}>
            {refine.notice}
          </p>
        ) : (
          <p className="text-[11px]" style={{ color: "var(--agw-text-subtle)" }}>
            AI can make mistakes. Review generated code.
          </p>
        )}
      </div>

      {/* Annotate a staged attachment — flattened back onto the card on Done. */}
      <AgentImageModal
        open={annotateId !== null}
        mode="annotate"
        src={annotateImg ? attachmentDataUrl(annotateImg) : null}
        onClose={() => setAnnotateId(null)}
        onSave={(dataUrl) => {
          if (!annotateId) return;
          const { base64, mediaType } = dataUrlToParts(dataUrl);
          if (base64) updateImage(annotateId, { base64, mediaType });
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
