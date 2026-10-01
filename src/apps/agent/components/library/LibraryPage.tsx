/**
 * Agent Window — Library [view].
 *
 * Everything Aurora has generated, been handed or made into a video, across
 * every conversation, in one place. Today that is the gallery view; the page
 * is its home on the icon rail, reachable from either product.
 */

import React from "react";

import { DestinationPage } from "@/apps/agent/components/shell/DestinationPage";
import { GalleryView } from "@/apps/agent/components/gallery/GalleryView";

export const LibraryPage: React.FC = () => (
  <DestinationPage title="Library">
    <GalleryView title="Library" />
  </DestinationPage>
);
