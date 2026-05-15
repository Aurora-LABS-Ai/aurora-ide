import React from "react";
import { resolveExplorerIcon } from "../../../lib/icon-registry";
import { useSettingsStore } from "../../../store/useSettingsStore";

interface ExplorerFileAssetIconProps {
  className?: string;
  fileName: string;
  path?: string;
}

/**
 * Resolve a file's explorer icon (Material / Seti / etc.) using the
 * user's current icon pack. Used everywhere the tool timeline needs
 * to display a file row without duplicating the lookup logic.
 */
export const ExplorerFileAssetIcon: React.FC<ExplorerFileAssetIconProps> = ({
  className,
  fileName,
  path,
}) => {
  const explorerIconPack = useSettingsStore((state) => state.explorerIconPack);
  const icon = resolveExplorerIcon(
    { name: fileName, path, isFolder: false },
    explorerIconPack,
  );

  return (
    <img
      src={icon.src || "/material-icons/file.svg"}
      alt=""
      className={className}
    />
  );
};
