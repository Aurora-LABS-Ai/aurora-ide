/**
 * Agent Window — every picture and video Aurora has made or been handed.
 *
 * Read from each Aurora Chat conversation's asset manifest by Rust
 * (`chat_gallery_list`), so it is a view over disk, not a store of its own.
 * Three sections (Generated, Pasted & uploaded, Videos), a search over
 * prompts and names, and the shared media actions from `useGalleryActions`.
 *
 * Hosted by the Library page. It used to be a dock tab that only existed on
 * the Chat side; pictures are Chat conversations, but the LIST of them is
 * something the whole app wants, which is why it moved to the icon rail.
 */

import React, { useId, useMemo, useState } from "react";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { GalleryTile } from "./GalleryTile";
import { GallerySelection } from "./GallerySelection";
import { RailMenu } from "@/apps/agent/components/shell/RailMenu";
import { useGallery } from "@/apps/agent/hooks/gallery/useGallery";
import {
  useGalleryActions,
  type GalleryMenuEvent,
} from "@/apps/agent/hooks/gallery/useGalleryActions";
import {
  filterGallery,
  galleryImageId,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";

const PAGE_SIZE = 36;

const GallerySection: React.FC<{
  title: string;
  images: GalleryImage[];
  onOpen: (image: GalleryImage) => void;
  onPreview: (image: GalleryImage) => void;
  onMenu: (event: GalleryMenuEvent, image: GalleryImage) => void;
}> = ({ title, images, onOpen, onPreview, onMenu }) => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  return (
    <section className="agw-gallery-section" aria-label={title}>
      <h3>
        {title} <span>{images.length}</span>
      </h3>
      {images.length ? (
        <div className="agw-gallery-grid">
          {images.slice(0, limit).map((image) => (
            <GalleryTile
              key={galleryImageId(image)}
              image={image}
              onOpen={() => onOpen(image)}
              onPreview={() => onPreview(image)}
              onMenu={(event) => onMenu(event, image)}
            />
          ))}
        </div>
      ) : (
        <p className="agw-gallery-empty">
          {title === "Videos" ? "No videos yet." : `No ${title.toLowerCase()} images.`}
        </p>
      )}
      {images.length > limit && (
        <button
          type="button"
          className="agw-gallery-more"
          onClick={() => setLimit((count) => count + PAGE_SIZE)}
        >
          Show more ({images.length - limit})
        </button>
      )}
    </section>
  );
};

export const GalleryView: React.FC<{ title?: string }> = ({ title = "Gallery" }) => {
  const tabId = useId();
  const { images, warnings, loading, error, refresh } = useGallery();
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<"all" | "generated" | "attached" | "videos">("all");
  const actions = useGalleryActions(images);
  const { selected, openError, notice, menu, closeMenu, selectImage, showPreview, openMenu } =
    actions;
  const matches = useMemo(() => filterGallery(images, query), [images, query]);
  const generated = matches.filter((image) => image.source !== "attached" && !image.video);
  const attached = matches.filter((image) => image.source === "attached");
  const videos = matches.filter((image) => image.video);

  return (
    <div className="agw-gallery">
      <header className="agw-gallery-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="agw-gallery-icon"
          title="Refresh gallery"
          aria-label="Refresh gallery"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <AgentIcon name="reset" size={15} />
        </button>
      </header>
      <div className="agw-gallery-controls">
        <label className="agw-gallery-search">
          <AgentIcon name="search" size={14} />
          <input
            type="search"
            aria-label="Search gallery"
            placeholder="Search gallery"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="agw-gallery-filters" role="tablist" aria-label="Gallery filter">
          {(
            [
              ["all", "All"],
              ["generated", "Generated"],
              ["attached", "Pasted & uploaded"],
              ["videos", "Videos"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              id={`${tabId}-${value}`}
              type="button"
              role="tab"
              aria-selected={section === value}
              aria-controls={`${tabId}-panel`}
              tabIndex={section === value ? 0 : -1}
              onClick={() => setSection(value)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const tabs = Array.from(
                  event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  ),
                );
                const current = tabs.indexOf(event.currentTarget);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                        tabs.length;
                tabs[next]?.click();
                tabs[next]?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
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
      {warnings.length > 0 && (
        <details className="agw-gallery-warnings">
          <summary>
            {warnings.length} {warnings.length === 1 ? "media issue" : "media issues"}
          </summary>
          {warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </details>
      )}
      <div
        className="agw-gallery-scroll agw-scroll"
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={`${tabId}-${section}`}
        tabIndex={0}
        aria-busy={loading && images.length === 0}
      >
        {loading && images.length === 0 ? (
          <p className="agw-gallery-empty" role="status">
            Loading gallery...
          </p>
        ) : images.length === 0 ? (
          <p className="agw-gallery-empty">No images or videos yet.</p>
        ) : matches.length === 0 ? (
          <p className="agw-gallery-empty" role="status">
            No images or videos match this search.
          </p>
        ) : (
          <>
            {(section === "all" || section === "generated") && (
              <GallerySection
                key={`generated:${query}`}
                title="Generated"
                images={generated}
                onOpen={selectImage}
                onPreview={showPreview}
                onMenu={openMenu}
              />
            )}
            {(section === "all" || section === "attached") && (
              <GallerySection
                key={`attached:${query}`}
                title="Pasted & uploaded"
                images={attached}
                onOpen={selectImage}
                onPreview={showPreview}
                onMenu={openMenu}
              />
            )}
            {(section === "all" || section === "videos") && (
              <GallerySection
                key={`videos:${query}`}
                title="Videos"
                images={videos}
                onOpen={selectImage}
                onPreview={showPreview}
                onMenu={openMenu}
              />
            )}
          </>
        )}
      </div>
      {selected && (
        <GallerySelection selected={selected} actions={actions} onRefresh={() => void refresh()} />
      )}
      {menu && <RailMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
};
