import React from "react";
import { Check, X } from "lucide-react";
import { cn } from "../helpers";
import { ExplorerFileAssetIcon } from "../ExplorerFileAssetIcon";
import { openFileInEditor } from "../open-file";
import type { MultiFileEntry } from "../types";

interface MultiFileResultsViewProps {
  files: MultiFileEntry[];
}

/**
 * One-row-per-file summary for `multi_file_read`. Successful entries
 * are clickable and open the file in Monaco; failed reads stay
 * disabled with their error text in the chip.
 */
export const MultiFileResultsView: React.FC<MultiFileResultsViewProps> = ({
  files,
}) => {
  const getFileName = (path: string) => path.split(/[/\\]/).pop() || path;

  return (
    <div className="flex flex-col gap-0.5 mt-1">
      {files.map((file, idx) => {
        const fileName = getFileName(file.path);
        return (
          <button
            key={idx}
            onClick={() =>
              file.success && file.content
                ? openFileInEditor(file.path, { fallbackContent: file.content })
                : undefined
            }
            disabled={!file.success}
            className={cn(
              "w-full flex items-center justify-between gap-2 rounded px-2 py-1 text-left group transition-colors",
              file.success
                ? "hover:bg-success/5 cursor-pointer"
                : "opacity-60 cursor-not-allowed",
            )}
          >
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              {file.success ? (
                <Check size={10} className="text-success shrink-0" />
              ) : (
                <X size={10} className="text-warning shrink-0" />
              )}
              <ExplorerFileAssetIcon
                fileName={fileName}
                path={file.path}
                className="w-3 h-3 flex-shrink-0"
              />
              <span className="truncate text-[10px] text-text-secondary group-hover:text-text-primary transition-colors">
                {fileName}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
};
