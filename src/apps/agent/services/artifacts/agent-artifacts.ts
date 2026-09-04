import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

export type AgentArtifactKind =
  | "html"
  | "svg"
  | "markdown"
  | "mermaid"
  | "react"
  /**
   * A research report: Markdown with the conventions a long document needs —
   * `##` headings that become a contents strip, `[^1]` footnotes that become
   * numbered sources you can open, block quotations with attribution.
   *
   * Deep-research conversations only. See `report-document.ts` for what the
   * panel reads out of the source.
   */
  | "report"
  /**
   * A picture in the conversation's `assets/`. The content is a JSON
   * `ImageArtifactContent` record naming the file, never the bytes — written by
   * Rust's `generate_image`, so `presentThreadArtifact` never sends this kind.
   */
  | "image";

/**
 * What an `image` artifact's content decodes to. Mirrors Rust's
 * `tools::image::assets::ImageArtifactContent` field for field (camelCase on
 * the wire); a record without an `asset` is refused by Rust before it is ever
 * stored, so a stored one always names its file.
 */
export interface ImageArtifactContent {
  /** File name inside the conversation's `assets/` folder. */
  asset: string;
  /** Absolute path of that file, as the asset protocol can load it. */
  path: string;
  mediaType: string;
  width: number;
  height: number;
  source: "generated" | "edited" | "attached";
  prompt?: string;
  model?: string;
  provider?: string;
  /** The asset this one was edited from. */
  parent?: string;
  createdAt: string;
}

/**
 * Decode an `image` artifact's content. `null` for anything that is not a
 * record naming its asset — the Canvas then says the entry is unreadable
 * instead of drawing a broken picture.
 */
export function parseImageArtifactContent(content: string): ImageArtifactContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.asset !== "string" || record.asset.trim() === "") return null;
  if (typeof record.path !== "string" || record.path.trim() === "") return null;
  const source =
    record.source === "generated" || record.source === "edited" || record.source === "attached"
      ? record.source
      : "generated";
  const optional = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  return {
    asset: record.asset,
    path: record.path,
    mediaType: typeof record.mediaType === "string" ? record.mediaType : "image/png",
    width: typeof record.width === "number" ? record.width : 0,
    height: typeof record.height === "number" ? record.height : 0,
    source,
    prompt: optional("prompt"),
    model: optional("model"),
    provider: optional("provider"),
    parent: optional("parent"),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
  };
}

export interface AgentArtifactVersion {
  tag: string;
  content: string;
  createdAt: string;
}

export interface AgentArtifactRecord {
  id: string;
  title: string;
  kind: AgentArtifactKind;
  versions: AgentArtifactVersion[];
}

export interface ThreadArtifactBundle {
  threadId: string;
  selectedArtifactId: string | null;
  selectedVersionTag: string | null;
  artifacts: AgentArtifactRecord[];
}

export interface ArtifactTextPatch {
  find: string;
  replace: string;
  all?: boolean;
}

interface PresentArtifactBase {
  artifactId: string;
  title: string;
  kind: AgentArtifactKind;
  /**
   * Set by the caller that ran this kind's engine gate — the Mermaid renderer,
   * the canvas compiler. Rust refuses to persist `mermaid` or `react` without
   * it, so the check cannot be skipped by a future call site that forgets.
   */
  validated?: boolean;
}

export type PresentArtifactInput = PresentArtifactBase &
  (
    | { content: string; baseVersionTag?: never; patches?: never }
    | { content?: never; baseVersionTag: string; patches: ArtifactTextPatch[] }
  );

export const listThreadArtifacts = (threadId: string): Promise<ThreadArtifactBundle> =>
  auroraInvoke<ThreadArtifactBundle>("thread_artifact_list", { threadId });

export const presentThreadArtifact = (
  threadId: string,
  input: PresentArtifactInput,
): Promise<ThreadArtifactBundle> =>
  auroraInvoke<ThreadArtifactBundle>("thread_artifact_upsert", {
    request: { threadId, ...input },
  });

export const previewThreadArtifactPatch = (
  threadId: string,
  input: Extract<PresentArtifactInput, { baseVersionTag: string }>,
): Promise<string> =>
  auroraInvoke<string>("thread_artifact_preview_patch", {
    request: { threadId, ...input },
  });

export const selectThreadArtifact = (
  threadId: string,
  artifactId: string,
  versionTag: string,
): Promise<ThreadArtifactBundle> =>
  auroraInvoke<ThreadArtifactBundle>("thread_artifact_select", {
    request: { threadId, artifactId, versionTag },
  });
