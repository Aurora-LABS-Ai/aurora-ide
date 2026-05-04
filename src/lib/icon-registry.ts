import {
  normalizeExplorerIconRequest,
  resolveExplorerIconFromPack,
} from "./icon-packs";
import type {
  ExplorerIconPackId,
  ExplorerIconRequest,
  ResolvedExplorerIcon,
} from "./icon-types";

const AURORA_FOLDER = ".aurora";

const isAuroraFolder = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return normalized === AURORA_FOLDER || normalized === "aurora";
};

const isAuroraRulesFile = ({ name, path, isFolder }: ExplorerIconRequest): boolean => {
  if (isFolder || !path || !name.toLowerCase().endsWith(".md")) {
    return false;
  }

  const normalizedPath = path.replace(/\\/g, "/");
  return normalizedPath.includes(`/${AURORA_FOLDER}/`);
};

export const resolveExplorerIcon = (
  request: ExplorerIconRequest,
  packId?: ExplorerIconPackId,
): ResolvedExplorerIcon => {
  const safeRequest = normalizeExplorerIconRequest(request);

  if (safeRequest.isFolder && isAuroraFolder(safeRequest.name)) {
    return {
      kind: "aurora-folder",
      alt: safeRequest.name,
    };
  }

  if (isAuroraRulesFile(safeRequest)) {
    return {
      kind: "aurora-rules",
      alt: safeRequest.name,
    };
  }

  return resolveExplorerIconFromPack(safeRequest, packId);
};
