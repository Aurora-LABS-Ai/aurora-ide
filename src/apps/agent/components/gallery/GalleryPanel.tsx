import React, { useId, useMemo, useState } from "react";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { GalleryTile } from "./GalleryTile";
import { GalleryVideoModal } from "./GalleryVideoModal";
import {
  RailMenu,
  type RailMenuState,
  type RailMenuItem,
} from "@/apps/agent/components/shell/RailMenu";
import { VideoResultView } from "@/apps/agent/components/tool-views/VideoResultView";
import {
  copyGalleryImage,
  copyGalleryPath,
  copyGalleryPrompt,
  revealGalleryMedia,
  saveGalleryMedia,
} from "@/apps/agent/services/gallery/gallery-actions";
import { useGallery } from "@/apps/agent/hooks/gallery/useGallery";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  filterGallery,
  galleryFileSrc,
  galleryImageId,
  galleryImageTitle,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";

const PAGE_SIZE = 36;

type MenuEvent =
  | React.MouseEvent<HTMLElement>
  | React.KeyboardEvent<HTMLElement>;
const GallerySection: React.FC<{
  title: string;
  images: GalleryImage[];
  onOpen: (image: GalleryImage) => void;
  onPreview: (image: GalleryImage) => void;
  onMenu: (event: MenuEvent, image: GalleryImage) => void;
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
          {title === "Videos"
            ? "No videos yet."
            : `No ${title.toLowerCase()} images.`}
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

// The guard also covers a persisted Gallery tab restored while Build is open.
export const GalleryPanel: React.FC = () => {
  const chat = useSettingsStore((state) => state.auroraSurface) === "chat";
  return chat ? <ChatGallery /> : null;
};

const ChatGallery: React.FC = () => {
  const tabId = useId();
  const { images, warnings, loading, error, refresh } = useGallery();
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<
    "all" | "generated" | "attached" | "videos"
  >("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [openError, setOpenError] = useState("");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<RailMenuState | null>(null);
  const matches = useMemo(() => filterGallery(images, query), [images, query]);
  const generated = matches.filter(
    (image) => image.source !== "attached" && !image.video,
  );
  const attached = matches.filter((image) => image.source === "attached");
  const videos = matches.filter((image) => image.video);
  const selected = images.find((image) => galleryImageId(image) === selectedId);
  const selectImage = (image: GalleryImage) => {
    setSelectedId(galleryImageId(image));
    setPreview(false);
    setOpenError("");
  };

  const showPreview = (image: GalleryImage) => {
    selectImage(image);
    setPreview(true);
  };
  const openConversation = async (image = selected) => {
    if (!image) return;
    setOpenError("");
    try {
      await useAgentChatStore.getState().selectThread(image.threadId, null);
      const failure = useAgentChatStore.getState().error;
      if (failure) setOpenError(failure);
    } catch (cause) {
      setOpenError(String(cause));
    }
  };

  const action = async (run: () => Promise<unknown>, message: string) => {
    setNotice("");
    setOpenError("");
    try {
      if ((await run()) !== false) setNotice(message);
    } catch (cause) {
      setOpenError(String(cause));
    }
  };
  const openMenu = (event: MenuEvent, image: GalleryImage) => {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget;
    anchor.focus();
    selectImage(image);
    const items: RailMenuItem[] = [
      {
        icon: "eye",
        label: image.video ? "Open video" : "Open image",
        onSelect: () => showPreview(image),
      },
      ...(!image.video
        ? [
            {
              icon: "copy" as const,
              label: "Copy image",
              onSelect: () =>
                void action(() => copyGalleryImage(image), "Image copied"),
            },
          ]
        : []),
      ...(image.path
        ? [
            {
              icon: "download" as const,
              label: "Save as...",
              onSelect: () =>
                void action(() => saveGalleryMedia(image), "Saved"),
            },
            {
              icon: "folder" as const,
              label: "Show in folder",
              onSelect: () => void action(() => revealGalleryMedia(image), ""),
            },
            {
              icon: "copy" as const,
              label: "Copy file path",
              onSelect: () =>
                void action(() => copyGalleryPath(image), "Path copied"),
            },
          ]
        : []),
      ...(image.prompt
        ? [
            {
              icon: "copy" as const,
              label: "Copy prompt",
              separatorBefore: true,
              onSelect: () =>
                void action(() => copyGalleryPrompt(image), "Prompt copied"),
            },
          ]
        : []),
      {
        icon: "chat",
        label: "Open chat",
        separatorBefore: true,
        onSelect: () => void openConversation(image),
      },
    ];
    const rect = anchor.getBoundingClientRect();
    setMenu({
      anchor,
      items,
      x: "clientX" in event && event.clientX ? event.clientX : rect.left + 12,
      y: "clientY" in event && event.clientY ? event.clientY : rect.top + 12,
    });
  };

  return (
    <div className="agw-gallery">
      <header className="agw-gallery-header">
        <h2>Gallery</h2>
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
        <div
          className="agw-gallery-filters"
          role="tablist"
          aria-label="Gallery filter"
        >
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
                const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                const current = tabs.indexOf(event.currentTarget);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                tabs[next]?.click(); tabs[next]?.focus();
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
            {warnings.length}{" "}
            {warnings.length === 1 ? "media issue" : "media issues"}
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
        <aside className="agw-gallery-selection" aria-label="Selected media">
          <button
            type="button"
            className="agw-gallery-icon"
            aria-label="Close image details"
            title="Close image details"
            onClick={() => setSelectedId(null)}
          >
            <AgentIcon name="close" size={14} />
          </button>
          <p className="agw-gallery-selected-title">
            {galleryImageTitle(selected)}
          </p>
          {!selected.video && (
            <p>
              {selected.width} x {selected.height}
              {selected.model ? ` / ${selected.model}` : ""}
            </p>
          )}
          {selected.video && !preview && (
            <VideoResultView
              key={selected.video.jobId}
              video={selected.video}
              onUpdate={() => void refresh()}
            />
          )}
          <p>{selected.threadTitle}</p>
          <div className="agw-gallery-actions">
            <button type="button" onClick={() => setPreview(true)}>
              <AgentIcon name="zoom-in" size={14} />
              {selected.video ? "View video" : "View image"}
            </button>
            <button
              type="button"
              aria-label="More media actions"
              title="More actions"
              onClick={(event) => openMenu(event, selected)}
            >
              <AgentIcon name="more" size={14} />
            </button>
            <button type="button" onClick={() => void openConversation()}>
              <AgentIcon name="chat" size={14} />
              Open chat
            </button>
          </div>
          {preview &&
            (selected.video ? (
              <GalleryVideoModal
                video={selected.video}
                onClose={() => setPreview(false)}
                onUpdate={() => void refresh()}
              />
            ) : (
              <AgentImageModal
                open
                src={galleryFileSrc(selected.path)}
                alt={galleryImageTitle(selected)}
                mode="preview"
                onClose={() => setPreview(false)}
              />
            ))}
        </aside>
      )}
      {menu && <RailMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
};
