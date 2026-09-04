/**
 * The two buttons on an image-provider card: **Test** and **Discover models**.
 *
 * Both run through Rust's `ImageClient` — the same client, headers and
 * parsers `generate_image` uses on a turn — so a row that passes here is a
 * row the tool can use. Neither spends a generation: `GET /models` with the
 * key is the cheapest authenticated call both formats offer, and it doubles
 * as the model list.
 *
 * The provider row is sent as stored. Its shape IS the wire shape
 * (`ImageProviderConfig` mirrors `ImageProvider` field for field), so there is
 * no snapshot step to drift.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { ImageProvider } from "@/apps/agent/services/providers/image-providers";

export interface ImageProviderTestReport {
  /** The address answered and accepted the key. */
  ok: boolean;
  /** The endpoint actually called. */
  url: string;
  /**
   * How many image models the provider listed. Zero is not a failure — a
   * provider can be reachable and list nothing Aurora recognises as an image
   * model — but it is worth saying.
   */
  imageModels: number;
  latencyMs: number;
  /** Present only on failure. Already human-readable. */
  error: string | null;
}

export interface DiscoveredImageModel {
  id: string;
  /**
   * `true` when the provider itself tagged it as an image model; `false` when
   * Aurora guessed from the name. The UI says which, so a guess is not
   * presented as a fact.
   */
  tagged: boolean;
}

/**
 * Never rejects for a provider-side failure — that arrives as `ok: false`
 * with an `error`. Only the IPC call itself can throw.
 */
export const testImageProvider = (provider: ImageProvider): Promise<ImageProviderTestReport> =>
  auroraInvoke<ImageProviderTestReport>("image_provider_test", { config: provider });

/** Rejects with the provider's own message when the list cannot be read. */
export const discoverImageModels = (provider: ImageProvider): Promise<DiscoveredImageModel[]> =>
  auroraInvoke<DiscoveredImageModel[]>("image_provider_discover_models", { config: provider });
