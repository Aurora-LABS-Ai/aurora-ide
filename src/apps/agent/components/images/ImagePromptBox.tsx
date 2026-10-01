/**
 * Agent Window — the Images page's prompt box.
 *
 * A description, a model, a size when the model offers several, and Send.
 * Deliberately not the conversation composer: that control carries
 * attachments, mentions, slash directives, dictation and a thread's draft,
 * none of which an image model can read. What it shares with the composer is
 * the surface (the same fill, edge and lift tokens) so the two boxes read as
 * one family, and the Send button, which is the composer's own.
 *
 * Enter sends, Shift+Enter breaks a line. The 4,000-character limit is the
 * Rust command's; it is shown here before the send rather than discovered
 * after a forty-second wait.
 */

import React, { useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentSelect } from "@/apps/agent/shared/AgentSelect";
import { RailMenu, type RailMenuState } from "@/apps/agent/components/shell/RailMenu";
import type { ReadyImageModel } from "@/apps/agent/lib/images/image-model-choice";

/** Mirrors `MAX_PROMPT_CHARS` in `commands/image_direct.rs`. */
export const MAX_IMAGE_PROMPT_CHARS = 4_000;
/** From here the counter shows, so the limit is never a surprise. */
const COUNTER_FROM = 3_600;

export const ImagePromptBox: React.FC<{
  models: readonly ReadyImageModel[];
  /** The selected model's `"<providerId>:<modelKey>"`. Must be one of `models`. */
  selection: string;
  onSelect: (selection: string) => void;
  onSubmit: (prompt: string, size: string | null) => void;
}> = ({ models, selection, onSelect, onSubmit }) => {
  const [text, setText] = useState("");
  // The chosen size is remembered WITH the model it was chosen for. A model
  // change therefore falls back to the new model's default by itself: a size
  // the last model offered is not a size this one takes.
  const [sizeChoice, setSizeChoice] = useState<{ selection: string; size: string } | null>(null);
  const [menu, setMenu] = useState<RailMenuState | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);

  const picked = models.find((entry) => entry.selection === selection) ?? models[0];
  const sizes = picked?.model.sizes ?? [];
  const defaultSize = picked?.model.defaultSize ?? sizes[0] ?? null;
  const chosen = sizeChoice?.selection === selection ? sizeChoice.size : null;
  const currentSize = chosen && sizes.includes(chosen) ? chosen : defaultSize;
  const setSize = (size: string) => setSizeChoice({ selection, size });

  // Grow with the text, up to the CSS max-height, then scroll inside.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const length = text.length;
  const over = length > MAX_IMAGE_PROMPT_CHARS;
  const canSend = !!picked && text.trim().length > 0 && !over;

  const send = () => {
    if (!canSend) return;
    onSubmit(text.trim(), currentSize);
    setText("");
    textarea.current?.focus();
  };

  const openModels = () => {
    const anchor = modelButton.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const severalProviders = new Set(models.map((entry) => entry.provider.id)).size > 1;
    setMenu({
      anchor,
      x: rect.left,
      y: rect.bottom + 6,
      items: models.map((entry) => ({
        icon: entry.selection === selection ? "check" : "image",
        label: severalProviders ? `${entry.label} · ${entry.provider.name}` : entry.label,
        onSelect: () => onSelect(entry.selection),
      })),
    });
  };

  return (
    <div className="agw-imgbox">
      <textarea
        ref={textarea}
        rows={1}
        value={text}
        aria-label="Describe a new image"
        placeholder="Describe a new image"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <div className="agw-imgbox-row">
        <button
          ref={modelButton}
          type="button"
          className="agw-imgbox-model"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title="Which model draws"
          onClick={openModels}
        >
          <AgentIcon name="image" size={14} />
          <span>{picked?.label ?? "Choose a model"}</span>
          <AgentIcon name="chevron-down" size={12} />
        </button>
        {sizes.length > 1 && currentSize && (
          <AgentSelect
            ariaLabel="Image size"
            value={currentSize}
            options={sizes.map((value) => ({ value, label: value }))}
            onChange={setSize}
          />
        )}
        {length >= COUNTER_FROM && (
          <span
            className="agw-imgbox-count"
            data-over={over || undefined}
            aria-live="polite"
          >
            {length.toLocaleString()} / {MAX_IMAGE_PROMPT_CHARS.toLocaleString()}
          </span>
        )}
        <button
          type="button"
          className="agw-send"
          aria-label="Make the picture"
          title={over ? `Shorten the prompt to ${MAX_IMAGE_PROMPT_CHARS.toLocaleString()} characters` : "Make the picture (Enter)"}
          disabled={!canSend}
          onClick={send}
        >
          <AgentIcon name="send" size={15} />
        </button>
      </div>
      {menu && <RailMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
};
