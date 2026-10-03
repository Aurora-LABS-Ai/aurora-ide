/**
 * Agent Window — every picture and video Aurora has made or been handed.
 *
 * Read from each Aurora Chat conversation's asset manifest by Rust
 * (`chat_gallery_list`), so it is a view over disk, not a store of its own.
 * One wall (`MediaWall`: justified rows grouped by day, newest first), a
 * filter (All, Generated, Pasted & uploaded, Videos), a search over prompts
 * and names, and the shared media actions from `useGalleryActions`.
 *
 * Hosted by the Library page. It used to be a dock tab that only existed on
 * the Chat side; pictures are Chat conversations, but the LIST of them is
 * something the whole app wants, which is why it moved to the icon rail.
 */

import React, { useId, useMemo, useState } from "react";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { GalleryDeleteConfirm } from "./GalleryDeleteConfirm";
import { GalleryViewer } from "./GalleryViewer";
import { MediaWall, type WallEntry } from "./MediaWall";
import { RailMenu } from "@/apps/agent/components/shell/RailMenu";
import { useGallery } from "@/apps/agent/hooks/gallery/useGallery";
import { useGalleryActions } from "@/apps/agent/hooks/gallery/useGalleryActions";
import {
  filterGallery,
  galleryImageId,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";

type Section = "all" | "generated" | "attached" | "videos";

const SECTIONS: readonly (readonly [Section, string])[] = [
  ["all", "All"],
  ["generated", "Generated"],
  ["attached", "Pasted & uploaded"],
  ["videos", "Videos"],
];

const inSection = (image: GalleryImage, section: Section): boolean =>
  section === "all" ||
  (section === "videos"
    ? !!image.video
    : section === "attached"
      ? image.source === "attached"
      : image.source !== "attached" && !image.video);

const EMPTY: Record<Section, string> = {
  all: "No images or videos yet.",
  generated: "No generated images yet.",
  attached: "No pasted or uploaded images yet.",
  videos: "No videos yet.",
};

export const GalleryView: React.FC<{ title?: string }> = ({ title = "Gallery" }) => {
  const tabId = useId();
  const { images, warnings, loading, loaded, error, refresh } = useGallery();
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("all");
  const actions = useGalleryActions(images, refresh);
  const { selected, openError, menu, closeMenu, showPreview, openMenu, visible } =
    actions;
  const entries = useMemo<WallEntry[]>(
    () =>
      visible(filterGallery(images, query))
        .filter((image) => inSection(image, section))
        .map((image) => ({ kind: "image", key: galleryImageId(image), image })),
    [images, query, section, visible],
  );
  const emptyText = query.trim()
    ? "Nothing matches this search."
    : EMPTY[section];

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
          {SECTIONS.map(([value, label]) => (
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
      >
        {/* Keyed by filter: switching tabs is a different set, drawn fresh
            rather than hundreds of tiles flying to new places. A search
            narrowing the same set glides. */}
        <MediaWall
          key={section}
          label={SECTIONS.find(([value]) => value === section)![1]}
          entries={entries}
          loading={!loaded}
          empty={emptyText}
          selectedKey={selected ? galleryImageId(selected) : null}
          isHidden={actions.isHidden}
          onOpen={showPreview}
          onPreview={showPreview}
          onMenu={openMenu}
          onToggleHidden={(image) => void actions.toggleHidden(image)}
          onDelete={actions.requestDelete}
        />
      </div>
      {selected && actions.preview && (
        <GalleryViewer
          image={selected}
          items={entries.flatMap((entry) => (entry.kind === "image" ? [entry.image] : []))}
          actions={actions}
          onRefresh={() => void refresh()}
        />
      )}
      {menu && <RailMenu menu={menu} onClose={closeMenu} />}
      <GalleryDeleteConfirm actions={actions} />
    </div>
  );
};
