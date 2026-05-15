import React, { useMemo, useState } from "react";
import { File, Folder, LayoutGrid } from "lucide-react";
import { cn } from "../helpers";
import type { FileListEntry } from "../types";

interface FileExplorerViewProps {
  files: FileListEntry[];
}

/**
 * Flat directory listing — used by `grep`'s `files_with_matches` mode
 * and by any tool that returns a `files: [...]` array. Collapses to
 * the first six entries until the user expands.
 */
export const FileExplorerView: React.FC<FileExplorerViewProps> = ({ files }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      if (!a?.name || !b?.name) return 0;
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "directory" ? -1 : 1;
    });
  }, [files]);

  const displayedFiles = isExpanded ? sortedFiles : sortedFiles.slice(0, 6);
  const remainingCount = sortedFiles.length - 6;

  return (
    <div className="mt-1 pl-1 border-l border-border/40">
      <div className="flex items-center gap-2 px-2 py-1">
        <LayoutGrid size={10} className="text-text-secondary" />
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          Directory Listing ({files.length})
        </span>
      </div>

      <div className="pl-2 mt-1 grid gap-0.5">
        {displayedFiles.map((file, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 rounded px-2 py-1 hover:bg-sidebar-item-hover transition-colors"
          >
            {file.type === "directory" ? (
              <Folder size={12} className="text-info/80 fill-info/10" />
            ) : (
              <File size={12} className="text-text-secondary" />
            )}
            <span
              className={cn(
                "truncate text-[10px]",
                file.type === "file"
                  ? "text-text-secondary"
                  : "text-text-primary font-medium",
              )}
            >
              {file.name}
            </span>
          </div>
        ))}
      </div>

      {!isExpanded && remainingCount > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(true);
          }}
          className="ml-2 mt-1 text-[10px] text-text-disabled hover:text-text-primary transition-colors flex items-center gap-1"
        >
          <span>+{remainingCount} more...</span>
        </button>
      )}

      {isExpanded && files.length > 6 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(false);
          }}
          className="ml-2 mt-1 text-[10px] text-text-disabled hover:text-text-primary transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  );
};
