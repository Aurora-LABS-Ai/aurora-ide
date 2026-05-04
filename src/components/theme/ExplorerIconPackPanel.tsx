import React, { useEffect, useRef, useState } from "react";
import { Check, FolderTree, Package, Trash2, Upload } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { clsx } from "clsx";

import {
  DEFAULT_EXPLORER_ICON_PACK_ID,
  listExplorerIconPacks,
} from "../../lib/icon-packs";
import type { ResolvedExplorerIcon } from "../../lib/icon-types";
import { isTauri } from "../../lib/tauri";
import { useIconPackImportDrag } from "../../hooks/useIconPackImportDrag";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useIconPackStore } from "../../store/useIconPackStore";
import {
  settingsCardStyle,
  settingsDangerPanelStyle,
  settingsSubtlePanelStyle,
} from "../modals/settings-shared";
import { ActionButton, StatusPill } from "../modals/settings-primitives";

const sampleRequests = [
  { name: "src", isFolder: true, isOpen: false },
  { name: "src", isFolder: true, isOpen: true },
  { name: "package.json", isFolder: false },
  { name: "app.tsx", isFolder: false },
] as const;

const renderPreviewIcon = (icon: ResolvedExplorerIcon, key: string) => {
  if (icon.kind === "asset" && icon.src) {
    return (
      <img
        key={key}
        src={icon.src}
        alt={icon.alt}
        className="h-5 w-5 object-contain"
        loading="lazy"
      />
    );
  }

  return (
    <div
      key={key}
      className="flex h-5 w-5 items-center justify-center rounded-[8px] text-text-secondary"
      style={settingsSubtlePanelStyle}
    >
      <Package size={12} />
    </div>
  );
};

export const ExplorerIconPackPanel: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { explorerIconPack, setExplorerIconPack } = useSettingsStore();
  const {
    deleteCustomPack,
    error,
    importAuroraIconPack,
    initializeFromDatabase,
    isInitialized,
    isLoading,
  } = useIconPackStore();

  const { isDragging: isTauriDragging } = useIconPackImportDrag();
  const [isInternalDragging, setIsInternalDragging] = useState(false);

  useEffect(() => {
    if (!isInitialized) {
      void initializeFromDatabase();
    }
  }, [initializeFromDatabase, isInitialized]);

  const iconPacks = listExplorerIconPacks();
  const activePack = iconPacks.find(
    (pack) => pack.manifest.id === explorerIconPack,
  );
  const isDragging = isTauriDragging || isInternalDragging;

  const processImport = async (content: string) => {
    await importAuroraIconPack(content);
  };

  const handleImportClick = async () => {
    if (isTauri()) {
      try {
        const selected = await open({
          multiple: false,
          filters: [
            {
              name: "Aurora Icon Packs",
              extensions: ["aurora"],
            },
          ],
        });

        if (selected && typeof selected === "string") {
          const content = await readTextFile(selected);
          await processImport(content);
        }
      } catch (importError) {
        console.error("Failed to import Aurora icon pack:", importError);
      }
      return;
    }

    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const content = loadEvent.target?.result as string;
      if (content) {
        await processImport(content);
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (isTauri()) return;

    setIsInternalDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (isTauri()) return;

    setIsInternalDragging(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (isTauri()) {
      setIsInternalDragging(false);
      return;
    }

    setIsInternalDragging(false);

    const file = event.dataTransfer.files[0];
    if (!file || !file.name.toLowerCase().endsWith(".aurora")) {
      console.error("Please drop a valid .aurora icon pack.");
      return;
    }

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const content = loadEvent.target?.result as string;
      if (content) {
        await processImport(content);
      }
    };
    reader.readAsText(file);
  };

  const handleDelete = async (packId: string) => {
    if (explorerIconPack === packId) {
      setExplorerIconPack(DEFAULT_EXPLORER_ICON_PACK_ID);
    }
    await deleteCustomPack(packId);
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      data-icon-pack-drop-zone="true"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[24px] border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-2 font-medium text-primary">
            <Upload size={24} />
            <span>Drop .aurora icon pack to import</span>
          </div>
        </div>
      )}

      <div className="flex-none space-y-4 px-3 pb-4">
        <div className="rounded-lg px-4 py-4" style={settingsCardStyle}>
          <div className="flex flex-col gap-3">
            <div>
            <p className="text-sm font-semibold text-text-primary">Icon Pack Library</p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Browse Aurora icon packs as cards, switch them instantly, or import a custom <code>.aurora</code> bundle.
            </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <StatusPill variant="neutral" dot={false}>
                {iconPacks.length} pack{iconPacks.length === 1 ? "" : "s"}
              </StatusPill>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".aurora,application/json"
                className="hidden"
              />
              <ActionButton
                variant="primary"
                icon={<Upload size={12} />}
                onClick={handleImportClick}
              >
                Import Pack
              </ActionButton>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg p-3 text-xs" style={settingsDangerPanelStyle}>
            {error}
          </div>
        )}

        {activePack && (
          <div
            className="rounded-lg px-4 py-3 text-[11px] leading-relaxed text-text-secondary"
            style={settingsSubtlePanelStyle}
          >
            Active pack: <span className="font-semibold text-text-primary">{activePack.manifest.name}</span>
            {activePack.manifest.version ? (
              <span className="text-text-secondary"> · v{activePack.manifest.version}</span>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-6 scrollbar-thin">
        {isLoading && iconPacks.length === 0 ? (
          <div className="p-4 text-xs text-text-secondary">Loading icon packs...</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3 pb-24">
            {iconPacks.map((pack) => {
              const isActive = pack.manifest.id === explorerIconPack;
              const previews = sampleRequests.map((request) => pack.resolveIcon(request));

              return (
                <div
                  key={pack.manifest.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setExplorerIconPack(pack.manifest.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setExplorerIconPack(pack.manifest.id);
                    }
                  }}
                  className={clsx(
                    "group relative cursor-pointer overflow-hidden border p-4 transition-all",
                    isActive
                      ? "border-primary ring-1 ring-primary"
                      : "border-border hover:border-primary/50",
                  )}
                  style={{...settingsCardStyle, borderRadius: 8}}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-text-primary">
                        {pack.manifest.name}
                        {isActive ? <Check size={12} className="text-primary" /> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-text-secondary">
                        {pack.manifest.author ? <span>by {pack.manifest.author}</span> : null}
                        {pack.manifest.source ? (
                          <StatusPill variant="neutral" dot={false}>
                            {pack.manifest.source}
                          </StatusPill>
                        ) : null}
                      </div>
                    </div>

                    {pack.manifest.source === "custom" ? (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(pack.manifest.id);
                        }}
                        className="rounded-lg p-2 opacity-0 transition-all group-hover:opacity-100 hover:text-danger"
                        style={settingsSubtlePanelStyle}
                        title="Delete icon pack"
                      >
                        <Trash2 size={12} />
                      </button>
                    ) : (
                      <div
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-primary"
                        style={settingsSubtlePanelStyle}
                      >
                        <FolderTree size={14} />
                      </div>
                    )}
                  </div>

                  <div className="mt-3 rounded-lg p-3" style={settingsSubtlePanelStyle}>
                    <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-text-secondary">
                      Preview
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {previews.map((icon, index) =>
                        renderPreviewIcon(icon, `${pack.manifest.id}-${index}`),
                      )}
                    </div>
                  </div>

                  <div className="mt-3 text-[11px] leading-relaxed text-text-secondary">
                    {pack.manifest.description || "Aurora explorer icon pack."}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
