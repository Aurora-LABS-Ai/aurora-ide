/**
 * A provider's logo, or its initial when we don't know one.
 *
 * The marks themselves live in `provider-marks.ts` — this file exports only
 * the component, which is what keeps fast refresh working on it.
 */

import React from "react";

import {
  detectBrand,
  providerInitial,
} from "@/apps/agent/services/providers/provider-brands";
import { IMAGE_MARKS, PROVIDER_MARKS } from "./provider-marks";

export const ProviderAvatar: React.FC<{
  provider: { id?: string; name?: string; nickname?: string; baseUrl?: string };
  small?: boolean;
}> = ({ provider, small }) => {
  const brand = detectBrand(provider);
  const image = brand ? IMAGE_MARKS[brand] : undefined;
  const Mark = brand && !image ? PROVIDER_MARKS[brand] : undefined;

  return (
    <span
      className={`agw-prov-avatar${small ? " agw-prov-avatar-sm" : ""}`}
      // Tells the stylesheet whether it is framing artwork that carries its own
      // background, or a glyph that needs Aurora's surface behind it.
      data-mark={image ? "image" : Mark ? "glyph" : undefined}
    >
      {image ? (
        // Decorative: the provider's name sits beside it in both places this
        // appears, so announcing the logo too would just say it twice.
        <img src={image} alt="" draggable={false} />
      ) : Mark ? (
        <Mark size={small ? 14 : 18} />
      ) : (
        providerInitial(provider)
      )}
    </span>
  );
};
