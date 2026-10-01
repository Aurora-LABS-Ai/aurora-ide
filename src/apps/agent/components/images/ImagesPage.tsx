/**
 * Agent Window — Images [view].
 *
 * Make a picture without starting a chat. The prompt box at the top calls the
 * image provider directly (`useAgentImagesStore`, no language model in the
 * loop); the grid underneath is every picture Aurora has generated, newest
 * first, with the pictures still being made holding their slots at the top.
 *
 * Each picture is also an Aurora Chat conversation pinned to the image model
 * that drew it, which is what "Open chat" on a tile continues — and why the
 * grid is the Library's Generated section, not a second store.
 */

import React, { useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { DestinationPage } from "@/apps/agent/components/shell/DestinationPage";
import { RailMenu } from "@/apps/agent/components/shell/RailMenu";
import { GallerySelection } from "@/apps/agent/components/gallery/GallerySelection";
import { GalleryTile } from "@/apps/agent/components/gallery/GalleryTile";
import { ImagePromptBox } from "./ImagePromptBox";
import { PendingImageTile } from "./PendingImageTile";
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

  const { images, loading, error, refresh } = useGallery();
  // A picture landed on disk: read the manifests again so it appears without
  // waiting for the hook's own ten-second poll.
  useEffect(() => {
    if (revision > 0) void refresh();
  }, [revision, refresh]);

  const generated = useMemo(
    () => images.filter((image) => image.source !== "attached" && !image.video),
    [images],
  );
  const actions = useGalleryActions(generated);
  const { selected, openError, notice, menu, closeMenu, selectImage, showPreview, openMenu } =
    actions;

  const choose = (selection: string) => {
    setChoice(selection);
    saveImageModelChoice(selection);
  };

  const submit = (prompt: string, size: string | null) => {
    if (!picked) return;
    void generate({
      prompt,
      provider: picked.provider,
      model: picked.model,
      modelSelection: picked.selection,
      size,
    });
  };

  const empty = jobs.length === 0 && generated.length === 0;

  return (
    <DestinationPage title="Images">
      <div className="agw-images">
        <header className="agw-images-head">
          <h2>Images</h2>
          <button
            type="button"
            className="agw-gallery-icon"
            title="Refresh"
            aria-label="Refresh images"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <AgentIcon name="reset" size={15} />
          </button>
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
        {notice && (
          <p className="agw-gallery-notice" role="status">
            {notice}
          </p>
        )}
        {openError && (
          <p className="agw-gallery-error" role="alert">
            {openError}
          </p>
        )}

        <div className="agw-images-scroll agw-scroll" aria-busy={loading && images.length === 0}>
          {!empty && (
            <div className="agw-images-sec">
              <h3>Generated</h3>
              <span className="agw-images-n">
                {jobs.length > 0 && `${jobs.length} in progress · `}
                {generated.length} {generated.length === 1 ? "picture" : "pictures"}
              </span>
            </div>
          )}
          {empty ? (
            <p className="agw-gallery-empty" role="status">
              {loading
                ? "Loading pictures..."
                : picked
                  ? "Nothing made yet. Describe a picture above."
                  : "Nothing made yet."}
            </p>
          ) : (
            <div className="agw-images-grid">
              {jobs.map((job) => (
                <PendingImageTile
                  key={job.id}
                  job={job}
                  onRetry={() => void retry(job.id)}
                  onDismiss={() => dismiss(job.id)}
                />
              ))}
              {generated.map((image) => (
                <GalleryTile
                  key={galleryImageId(image)}
                  image={image}
                  onOpen={() => selectImage(image)}
                  onPreview={() => showPreview(image)}
                  onMenu={(event) => openMenu(event, image)}
                />
              ))}
            </div>
          )}
        </div>

        {selected && (
          <GallerySelection selected={selected} actions={actions} onRefresh={() => void refresh()} />
        )}
        {menu && <RailMenu menu={menu} onClose={closeMenu} />}
      </div>
    </DestinationPage>
  );
};
