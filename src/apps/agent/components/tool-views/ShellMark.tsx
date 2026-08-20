/**
 * Agent Window — the picture of a shell [view].
 *
 * ONE component for the mark, used by every surface that names a shell: the
 * badge on the tool row, the header of the expanded result, and the header of
 * the live stream. They previously disagreed — the row carried the shell's own
 * mark while both headers drew a generic accent-coloured terminal glyph, so a
 * `bash` run showed two different pictures of itself eight pixels apart.
 *
 * The mark comes from the active explorer icon pack and falls back to a drawn
 * monochrome silhouette. See `shell-icon.ts` for why the fallback is the
 * ordinary path rather than a safety net: Material ships no cmd mark, so on the
 * default pack one of the three families always draws its own.
 *
 * Colour is the HOST's decision and this component never sets it. A brand asset
 * brings its own; the drawn fallback inherits `currentColor`, so the badge gets
 * the chip's text colour and the result header keeps its accent.
 */

import React, { useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import {
  shellBrandAsset,
  shellFallbackIcon,
} from "@/apps/agent/components/tool-views/shell-icon";
import type { ShellMeta } from "@/apps/agent/components/tool-views/shell-meta";

export const ShellMark: React.FC<{
  shell: ShellMeta;
  /** Active explorer icon pack id; `null` uses the drawn marks throughout. */
  packId: string | null | undefined;
  size?: number;
}> = ({ shell, packId, size = 12 }) => {
  const [assetFailed, setAssetFailed] = useState(false);
  const asset = assetFailed ? null : shellBrandAsset(shell.family, packId);

  if (!asset) {
    return (
      <AgentIcon name={shellFallbackIcon(shell.family)} size={size} strokeWidth={2} />
    );
  }

  return (
    <img
      src={asset}
      alt=""
      width={size}
      height={size}
      // A pack that is renamed, trimmed or replaced by a custom one would
      // otherwise put a broken-image glyph on every shell row in the
      // transcript — a visible defect caused by pure decoration. The drawn
      // mark is always there, so the worst case is invisible.
      onError={() => setAssetFailed(true)}
    />
  );
};
