import {
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  DEFAULT_FOLDER_OPENED,
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from "vscode-icons-js";

import type {
  ExplorerIconPack,
  ExplorerIconRequest,
  ResolvedExplorerIcon,
} from "./icon-types";

const normalizeVscodeIconAssetName = (iconFileName: string): string => {
  switch (iconFileName) {
    case "file_type_pdf.svg":
      return "file-type-pdf2.svg";
    case "file_type_affectscript.svg":
      return "default-file.svg";
    default:
      return iconFileName.replaceAll("_", "-");
  }
};

const getVscodeIconUrl = (iconFileName: string): string => {
  return `/vscode-icons/${normalizeVscodeIconAssetName(iconFileName)}`;
};

export const resolveVsCodeExplorerIcon = (
  request: ExplorerIconRequest,
): ResolvedExplorerIcon => {
  const iconFileName = request.isFolder
    ? request.isOpen
      ? getIconForOpenFolder(request.name.toLowerCase()) ?? DEFAULT_FOLDER_OPENED
      : getIconForFolder(request.name.toLowerCase()) ?? DEFAULT_FOLDER
    : getIconForFile(request.name) ?? DEFAULT_FILE;

  return {
    kind: "asset",
    alt: request.name,
    src: getVscodeIconUrl(iconFileName),
  };
};

export const vscodeExplorerIconPack: ExplorerIconPack = {
  manifest: {
    id: "vscode",
    name: "VS Code Icons",
    version: "11.6.1",
    description:
      "Transparent VS Code-style explorer icons backed by local self-hosted SVG assets.",
    source: "built-in",
  },
  resolveIcon: resolveVsCodeExplorerIcon,
};
