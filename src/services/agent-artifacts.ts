import { auroraInvoke } from "../lib/runtime";

export type AgentArtifactKind = "html" | "svg" | "markdown" | "mermaid";

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
