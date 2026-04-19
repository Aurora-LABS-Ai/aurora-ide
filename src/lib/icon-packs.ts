import type {
  ExplorerIconPack,
  ExplorerIconPackId,
  ExplorerIconRequest,
  ResolvedExplorerIcon,
} from "./icon-types";
import { materialExplorerIconPack } from "./material-icon-theme";
import { vscodeExplorerIconPack } from "./vscode-icon-theme";

const BUILTIN_ICON_PACKS: Record<ExplorerIconPackId, ExplorerIconPack> = {
  material: materialExplorerIconPack,
  vscode: vscodeExplorerIconPack,
};
let customExplorerIconPacks: Record<ExplorerIconPackId, ExplorerIconPack> = {};

export const DEFAULT_EXPLORER_ICON_PACK_ID: ExplorerIconPackId = "material";

let activeExplorerIconPackId: ExplorerIconPackId = DEFAULT_EXPLORER_ICON_PACK_ID;

const getAvailableExplorerIconPacks = (): Record<
  ExplorerIconPackId,
  ExplorerIconPack
> => {
  return {
    ...BUILTIN_ICON_PACKS,
    ...customExplorerIconPacks,
  };
};

export const listExplorerIconPacks = (): ExplorerIconPack[] => {
  const builtInIds = Object.keys(BUILTIN_ICON_PACKS);
  const customIds = Object.keys(customExplorerIconPacks).sort((a, b) =>
    a.localeCompare(b),
  );

  return [...builtInIds, ...customIds]
    .map((packId) => getAvailableExplorerIconPacks()[packId])
    .filter(Boolean);
};

export const getExplorerIconPack = (
  packId: ExplorerIconPackId = activeExplorerIconPackId,
): ExplorerIconPack => {
  const availablePacks = getAvailableExplorerIconPacks();
  return (
    availablePacks[packId] ?? availablePacks[DEFAULT_EXPLORER_ICON_PACK_ID]
  );
};

export const getActiveExplorerIconPackId = (): ExplorerIconPackId => {
  return activeExplorerIconPackId;
};

export const isExplorerIconPackAvailable = (
  packId: string,
): packId is ExplorerIconPackId => {
  return Boolean(getAvailableExplorerIconPacks()[packId]);
};

export const isBuiltInExplorerIconPack = (
  packId: string,
): boolean => {
  return Boolean(BUILTIN_ICON_PACKS[packId]);
};

export const registerCustomExplorerIconPacks = (
  packs: ExplorerIconPack[],
): void => {
  customExplorerIconPacks = Object.fromEntries(
    packs.map((pack) => [pack.manifest.id, pack] as const),
  );
};

export const setActiveExplorerIconPackId = (packId: ExplorerIconPackId): void => {
  activeExplorerIconPackId = isExplorerIconPackAvailable(packId)
    ? packId
    : DEFAULT_EXPLORER_ICON_PACK_ID;
};

export const resolveExplorerIconFromPack = (
  request: ExplorerIconRequest,
  packId?: ExplorerIconPackId,
): ResolvedExplorerIcon => {
  return getExplorerIconPack(packId).resolveIcon(request);
};
