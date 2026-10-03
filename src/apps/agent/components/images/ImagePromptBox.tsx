/**
 * Agent Window — the Images page's prompt box.
 *
 * A description, a model, a size when the model offers several, and Send.
 * Deliberately not the conversation composer: that control carries mentions,
 * slash directives, dictation and a thread's draft, none of which an image
 * model can read. What it shares with the composer is the surface (the same
 * fill, edge and lift tokens) so the two boxes read as one family, and the
 * Send button, which is the composer's own.
 *
 * ONE picture can ride along, to be edited: dropped from the OS or the Files
 * panel, or picked with `+`. It is read at full quality (`imageFileForEdit`,
 * not the 1024px vision copy) and sent as the same `<aurora_image>` marker a
 * chat attachment is; the Rust command turns it into an edit. A model that
 * cannot edit still accepts the drop, so the picture is never lost, but says
 * so and holds Send until a model that can is picked or the picture is removed.
 *
 * Enter sends, Shift+Enter breaks a line. The 4,000-character limit is the
 * Rust command's; it is shown here before the send rather than discovered
 * after a forty-second wait.
 */

import React, { useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentSelect } from "@/apps/agent/shared/AgentSelect";
import { useAgentExternalDrop } from "@/apps/agent/hooks/drag/useAgentExternalDrop";
import { useAgentPathDrop } from "@/apps/agent/hooks/drag/useAgentPathDrop";
import {
  loadImageSizeChoice,
  saveImageSizeChoice,
  type ReadyImageModel,
} from "@/apps/agent/lib/images/image-model-choice";
import { useAgentImagesStore } from "@/apps/agent/store/images/useAgentImagesStore";
import { imageFileForEdit, isImagePath } from "@/apps/agent/lib/render/image-utils";
import { canEditWith } from "@/apps/agent/services/providers/image-providers";
import {
  attachmentDataUrl,
  type ImageAttachment,
} from "@/apps/agent/store/composer/useAgentAttachmentStore";
import { openFileDialog } from "@/kernel/lib/ipc/tauri";

const EDIT_PICKER_FILTER = [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }];

/** Mirrors `MAX_PROMPT_CHARS` in `commands/image_direct.rs`. */
export const MAX_IMAGE_PROMPT_CHARS = 4_000;
/** From here the counter shows, so the limit is never a surprise. */
const COUNTER_FROM = 3_600;

export const ImagePromptBox: React.FC<{
  models: readonly ReadyImageModel[];
  /** The selected model's `"<providerId>:<modelKey>"`. Must be one of `models`. */
  selection: string;
  onSelect: (selection: string) => void;
  /** `source` is the picture to edit, when one is attached. */
  onSubmit: (prompt: string, size: string | null, source: ImageAttachment | null) => void;
}> = ({ models, selection, onSelect, onSubmit }) => {
  const [text, setText] = useState("");
  const [ownSource, setOwnSource] = useState<ImageAttachment | null>(null);
  // "Edit this image" from any tile hands its picture over through the store;
  // it wins until replaced, removed or sent, and is cleared from the store then.
  const handedOver = useAgentImagesStore((s) => s.editSource);
  const source = handedOver ?? ownSource;
  const setSource = (next: ImageAttachment | null) => {
    if (useAgentImagesStore.getState().editSource) {
      useAgentImagesStore.getState().setEditSource(null);
    }
    setOwnSource(next);
  };
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // The chosen size is remembered WITH the model it was chosen for, across
  // restarts (`image-model-choice`). Switching model brings back that model's
  // own last size; one it no longer offers falls back to its default.
  const [sizeChoice, setSizeChoice] = useState<Record<string, string>>({});
  const textarea = useRef<HTMLTextAreaElement>(null);

  const picked = models.find((entry) => entry.selection === selection) ?? models[0];
  const sizes = picked?.model.sizes ?? [];
  const defaultSize = picked?.model.defaultSize ?? sizes[0] ?? null;
  const chosen = sizeChoice[selection] ?? loadImageSizeChoice(selection);
  const currentSize = chosen && sizes.includes(chosen) ? chosen : defaultSize;
  const setSize = (size: string) => {
    setSizeChoice((current) => ({ ...current, [selection]: size }));
    saveImageSizeChoice(selection, size);
  };

  // A handed-over picture is ready to describe a change to.
  useEffect(() => {
    if (handedOver) textarea.current?.focus();
  }, [handedOver]);

  // Grow with the text, up to the CSS max-height, then scroll inside.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const length = text.length;
  const over = length > MAX_IMAGE_PROMPT_CHARS;
  const pickedCanEdit = !!picked && canEditWith(picked.provider, picked.model);
  /** A picture is attached but this model cannot change it. */
  const blockedEdit = !!source && !pickedCanEdit;
  const canSend = !!picked && text.trim().length > 0 && !over && !blockedEdit;

  const send = () => {
    if (!canSend) return;
    onSubmit(text.trim(), currentSize, source);
    setText("");
    setSource(null);
    setSourceNote(null);
    textarea.current?.focus();
  };

  /** Take the first picture among dropped or picked paths. */
  const takePaths = (paths: string[]) => {
    const pictures = paths.filter(isImagePath);
    if (pictures.length === 0) {
      setSourceNote("Drop a picture to edit — PNG, JPEG, WebP or GIF.");
      return;
    }
    void imageFileForEdit(pictures[0])
      .then((attachment) => {
        setSource(attachment);
        setSourceNote(
          pictures.length > 1 ? `Edits take one picture at a time — using ${attachment.name}.` : null,
        );
        textarea.current?.focus();
      })
      .catch((error: unknown) =>
        setSourceNote(error instanceof Error ? error.message : "That picture could not be read."),
      );
  };
  const osDragOver = useAgentExternalDrop(box, takePaths);
  const pathDragOver = useAgentPathDrop(box, takePaths);

  const pickPicture = async () => {
    try {
      const picked = await openFileDialog({ multiple: false, filters: EDIT_PICKER_FILTER });
      if (!picked) return;
      takePaths(Array.isArray(picked) ? picked : [picked]);
    } catch (error) {
      setSourceNote(error instanceof Error ? error.message : "The file picker could not open.");
    }
  };

  // Grouped by provider when there is more than one; the list scrolls inside
  // its popover past a handful. "Edits" marks the models that can take a
  // picture to change, so the way out of "this model cannot edit" is visible.
  const severalProviders = new Set(models.map((entry) => entry.provider.id)).size > 1;
  const modelOptions = models.map((entry) => ({
    value: entry.selection,
    label: entry.label,
    group: severalProviders ? entry.provider.name : undefined,
    mark: canEditWith(entry.provider, entry.model)
      ? { icon: "pencil" as const, label: "Edits" }
      : undefined,
  }));

  const describe = source ? "Describe the change" : "Describe a new image";

  return (
    <div className="agw-imgbox" ref={box} data-drop={osDragOver || pathDragOver || undefined}>
      {source && (
        <div className="agw-imgbox-source" title={source.name}>
          <img src={attachmentDataUrl(source)} alt={`Picture to edit: ${source.name}`} />
          <button
            type="button"
            className="agw-imgbox-source-remove"
            aria-label={`Remove ${source.name}`}
            title="Remove the picture"
            onClick={() => {
              setSource(null);
              setSourceNote(null);
            }}
          >
            <AgentIcon name="close" size={13} />
          </button>
        </div>
      )}
      {(blockedEdit || sourceNote) && (
        <p className="agw-imgbox-note" data-tone={blockedEdit ? "warn" : undefined} role="status">
          {blockedEdit
            ? `${picked?.label ?? "This model"} cannot edit pictures. Pick a model marked with a pencil, or remove the picture to make a new one.`
            : sourceNote}
        </p>
      )}
      <textarea
        ref={textarea}
        rows={1}
        value={text}
        aria-label={describe}
        placeholder={describe}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <div className="agw-imgbox-row">
        <button
          type="button"
          className="agw-imgbox-attach"
          aria-label="Add a picture to edit"
          title="Add a picture to edit (or drop one here)"
          onClick={() => void pickPicture()}
        >
          <AgentIcon name="plus" size={15} />
        </button>
        <AgentSelect
          className="agw-imgbox-modelsel"
          ariaLabel="Image model"
          leadingIcon="image"
          value={picked?.selection ?? ""}
          options={modelOptions}
          minMenuWidth={280}
          onChange={onSelect}
        />
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
          aria-label={source ? "Edit the picture" : "Make the picture"}
          title={
            over
              ? `Shorten the prompt to ${MAX_IMAGE_PROMPT_CHARS.toLocaleString()} characters`
              : blockedEdit
                ? "This model cannot edit pictures"
                : source
                  ? "Edit the picture (Enter)"
                  : "Make the picture (Enter)"
          }
          disabled={!canSend}
          onClick={send}
        >
          <AgentIcon name="send" size={15} />
        </button>
      </div>
    </div>
  );
};
