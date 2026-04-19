import { resolveExplorerIconFromPack } from "./icon-packs";
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
  if (request.isFolder && isAuroraFolder(request.name)) {
    return {
      kind: "aurora-folder",
      alt: request.name,
    };
  }

  if (isAuroraRulesFile(request)) {
    return {
      kind: "aurora-rules",
      alt: request.name,
    };
  }

  return resolveExplorerIconFromPack(request, packId);
};
