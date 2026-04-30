/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 *
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 *
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 *
 * See: DOCS/theme-dev.md for full token reference
 */

/**
 * TreeNodeRow Component
 * Visual representation of a file/folder row with mouse-based drag support.
 *
 * Design notes (enterprise-grade IDE feel):
 *   - Row height ~22px, no chat-app-y rounded pills.
 *   - Selection: subtle primary tint (no inset shadows, no inverted text).
 *   - Hover: faint sidebar-item-hover tint, snappy 80ms transition.
 *   - Indent guides: 1px lines at low opacity; the active branch (current row's
 *     ancestors when row is hovered/selected) is brought to higher opacity.
 *   - Active accent: 2px primary bar pinned to the left edge for the selected row.
 */

import React, { useCallback } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { FileIcon, FolderIcon } from "../FileIcons";
import { useDragStore } from "../../../store/useDragStore";

interface TreeNodeRowProps {
  name: string;
  path: string;
  isFolder: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  level: number;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const INDENT_PX = 12;
const INDENT_BASE_OFFSET = 14;

export const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  name,
  path,
  isFolder,
  isExpanded,
  isSelected,
  level,
  onClick,
  onContextMenu,
}) => {
  const { isDragging, dropTargetPath, prepareDrag, draggedPath } =
    useDragStore();

  const isDropTarget = isDragging && isFolder && dropTargetPath === path;
  const isBeingDragged = isDragging && draggedPath === path;
  const [isHovered, setIsHovered] = React.useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (isFolder) return;
      prepareDrag(path, name, e.clientX, e.clientY);
    },
    [isFolder, path, name, prepareDrag],
  );

  const handleClick = useCallback(() => {
    const state = useDragStore.getState();
    if (state.isDragging) return;
    onClick();
  }, [onClick]);

  // Indent guides — render one vertical 1px line per nesting level. The active
  // branch (rendered when the row is hovered or selected) lifts opacity so the
  // user can clearly trace which ancestors a row belongs to, without the noisy
  // permanent-emphasis look that plagues most IDEs.
  const indentGuides: React.ReactNode[] = [];
  for (let i = 0; i < level; i++) {
    indentGuides.push(
      <div
        key={i}
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: i * INDENT_PX + INDENT_BASE_OFFSET,
          width: 1,
          backgroundColor: "var(--aurora-editor-indent-guide, #404040)",
          opacity: isSelected || isHovered ? 0.42 : 0.18,
          transition: "opacity 100ms ease",
          pointerEvents: "none",
        }}
      />,
    );
  }

  // Background tint per state. Selection wins over hover; both stay subtle so
  // the file/folder names remain the visual focus, not the chrome.
  const backgroundColor = isSelected
    ? "color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)"
    : isHovered
      ? "color-mix(in srgb, var(--aurora-sidebar-item-hover, var(--aurora-common-primary)) 55%, transparent)"
      : "transparent";

  return (
    <div
      className={clsx(
        "group relative mx-1 flex items-center gap-1.5 rounded-[4px] py-[3px] pr-2 cursor-pointer select-none",
        isDropTarget && "ring-1 ring-[var(--aurora-common-primary)] z-10",
        isBeingDragged && "opacity-50 grayscale",
      )}
      style={{
        height: 22,
        paddingLeft: level * INDENT_PX + INDENT_BASE_OFFSET - 2,
        backgroundColor,
        transition: "background-color 80ms ease",
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onContextMenu={onContextMenu}
      draggable={false}
      data-file-path={path}
      {...(isFolder ? { "data-folder-path": path } : {})}
    >
      {/* Indent guides (rendered first so chrome can sit above them) */}
      {indentGuides}

      {/* Active selection accent — 2px primary bar pinned to the left edge */}
      {isSelected && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: 2,
            backgroundColor: "var(--aurora-common-primary)",
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
      )}

      {/* Chevron / Spacer */}
      <span
        className={clsx(
          "z-10 flex h-3.5 w-3.5 items-center justify-center transition-transform duration-150",
          isFolder && isExpanded && "rotate-90",
        )}
        style={{
          color: "var(--aurora-sidebar-foreground)",
          opacity: isFolder ? (isHovered || isSelected ? 0.85 : 0.6) : 0,
        }}
      >
        {isFolder && <ChevronRight className="w-3 h-3" />}
      </span>

      {/* Icon */}
      <div className="flex items-center justify-center z-10 relative shrink-0">
        {isFolder ? (
          <FolderIcon
            name={name}
            className="w-4 h-4"
            open={isExpanded}
            path={path}
          />
        ) : (
          <FileIcon name={name} className="w-4 h-4" path={path} />
        )}
      </div>

      {/* Filename */}
      <span
        className="relative z-10 truncate text-[12px] leading-none"
        style={{
          color: "var(--aurora-sidebar-foreground)",
          fontWeight: isSelected ? 500 : 400,
          opacity: isSelected ? 1 : isHovered ? 0.96 : 0.88,
        }}
      >
        {name}
      </span>
    </div>
  );
};
