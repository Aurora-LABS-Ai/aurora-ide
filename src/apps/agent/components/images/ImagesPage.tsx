/**
 * Agent Window — Images [view].
 *
 * Make a picture without starting a chat. The prompt box at the top calls the
 * image provider directly (`useAgentImagesStore`, no language model in the
 * loop); the wall underneath is every picture Aurora has generated, newest
 * first and grouped by day, with the pictures still being made holding their
 * slots at the front. A finished job keeps its slot (showing its picture)
 * until the gallery lists that picture under the same key, so a landing is
 * one quiet swap, not a tile vanishing and another appearing.
 *
 * Each picture is also an Aurora Chat conversation pinned to the image model
 * that drew it, which is what "Open chat" on a tile continues — and why the
 * grid is the Library's Generated section, not a second store.
 */

import React, { useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { DestinationPage } from "@/apps/agent/components/shell/DestinationPage";
import { RailMenu } from "@/apps/agent/components/shell/RailMenu";
import { GalleryDeleteConfirm } from "@/apps/agent/components/gallery/GalleryDeleteConfirm";
import { GalleryViewer } from "@/apps/agent/components/gallery/GalleryViewer";
import { MediaWall, type WallEntry } from "@/apps/agent/components/gallery/MediaWall";
import { ImagePromptBox } from "./ImagePromptBox";
import { useGallery } from "@/apps/agent/hooks/gallery/useGallery";
import { useGalleryActions } from "@/apps/agent/hooks/gallery/useGalleryActions";
import {
  loadImageModelChoice,
  pickImageModel,
  readyImageModels,
  saveImageModelChoice,
} from "@/apps/agent/lib/images/image-model-choice";
import { galleryImageId } from "@/apps/agent/services/gallery/gallery-service";
import { useAgentImagesStore } from "@/apps/agent/store/images/useAgentImagesStore";
import type { ImageAttachment } from "@/apps/agent/store/composer/useAgentAttachmentStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";

export const ImagesPage: React.FC = () => {
  const providers = useAgentSettingsStore((s) => s.imageProviders);
  const openSettings = useAgentUiStore((s) => s.openSettings);
  const models = useMemo(() => readyImageModels(providers), [providers]);
  const [choice, setChoice] = useState<string | null>(() => loadImageModelChoice());
  const picked = pickImageModel(models, choice);

  const jobs = useAgentImagesStore((s) => s.jobs);
  const revision = useAgentImagesStore((s) => s.revision);
  const generate = useAgentImagesStore((s) => s.generate);
  const retry = useAgentImagesStore((s) => s.retry);
  const dismiss = useAgentImagesStore((s) => s.dismiss);
  const settle = useAgentImagesStore((s) => s.settle);

  const { images, loaded, error, refresh } = useGallery();
  // A picture landed on disk: read the manifests again so it appears without
  // waiting for the hook's own ten-second poll.
  useEffect(() => {
    if (revision > 0) void refresh();
  }, [revision, refresh]);

  const generated = useMemo(
    () => images.filter((image) => image.source !== "attached" && !image.video),
    [images],
  );
  const actions = useGalleryActions(generated, refresh);
  const { selected, openError, menu, closeMenu, showPreview, openMenu, visible } =
    actions;

  // Finished jobs whose picture the gallery now lists hand their slot over.
  const galleryKeys = useMemo(() => new Set(generated.map(galleryImageId)), [generated]);
  useEffect(() => settle(galleryKeys), [galleryKeys, settle]);

  // Jobs first (they are the newest), keyed by the gallery id their picture
  // will have, so the slot and the listed picture are the same React node.
  const entries = useMemo<WallEntry[]>(() => {
    const out: WallEntry[] = [];
    for (const job of jobs) {
      if (job.resultKey && galleryKeys.has(job.resultKey)) continue;
      out.push({ kind: "job", key: job.resultKey ?? job.id, job });
    }
    for (const image of visible(generated)) {
      out.push({ kind: "image", key: galleryImageId(image), image });
    }
    return out;
  }, [jobs, generated, galleryKeys, visible]);
  const wallImages = useMemo(
    () => entries.flatMap((entry) => (entry.kind === "image" ? [entry.image] : [])),
    [entries],
  );

  const choose = (selection: string) => {
    setChoice(selection);
    saveImageModelChoice(selection);
  };

  const submit = (prompt: string, size: string | null, source: ImageAttachment | null) => {
    if (!picked) return;
    void generate({
      prompt,
      provider: picked.provider,
      model: picked.model,
      modelSelection: picked.selection,
      size,
      source,
    });
  };

  return (
    <DestinationPage title="Images">
      <div className="agw-images">
        {/* No refresh button: the wall refreshes itself (on a landing, on
            focus, and every ten seconds — `useGallery`). */}
        <header className="agw-images-head">
          <h2>Images</h2>
        </header>

        {picked ? (
          <ImagePromptBox
            models={models}
            selection={picked.selection}
            onSelect={choose}
            onSubmit={submit}
          />
        ) : (
          <div className="agw-images-none" role="status">
            <p>No image provider is ready.</p>
            <p>
              Add a provider and its key under Settings → Providers → Image providers, and the
              prompt box appears here.
            </p>
            <div className="agw-gallery-actions">
              <button type="button" onClick={() => openSettings("providers")}>
                <AgentIcon name="settings" size={14} />
                Open provider settings
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="agw-gallery-error" role="alert">
            {error}{" "}
            <button type="button" onClick={() => void refresh()}>
              Try again
            </button>
          </p>
        )}
        {openError && (
          <p className="agw-gallery-error" role="alert">
            {openError}
          </p>
        )}

        <div className="agw-images-scroll agw-scroll">
          <MediaWall
            label="Generated pictures"
            entries={entries}
            loading={!loaded}
            empty={picked ? "Nothing made yet. Describe a picture above." : "Nothing made yet."}
            selectedKey={selected ? galleryImageId(selected) : null}
            isHidden={actions.isHidden}
            onOpen={showPreview}
            onPreview={showPreview}
            onMenu={openMenu}
            onToggleHidden={(image) => void actions.toggleHidden(image)}
            onDelete={actions.requestDelete}
            onRetry={(job) => void retry(job.id)}
            onDismiss={(job) => dismiss(job.id)}
          />
        </div>

        {selected && actions.preview && (
          <GalleryViewer
            image={selected}
            items={wallImages}
            actions={actions}
            onRefresh={() => void refresh()}
          />
        )}
        {menu && <RailMenu menu={menu} onClose={closeMenu} />}
        <GalleryDeleteConfirm actions={actions} />
      </div>
    </DestinationPage>
  );
};
