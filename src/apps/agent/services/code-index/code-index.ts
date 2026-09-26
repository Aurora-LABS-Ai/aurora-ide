import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";

export interface IndexSettings { autoBuild: boolean; searchResults: number; searchBytes: number }
export const DEFAULT_INDEX_SETTINGS: IndexSettings = { autoBuild: true, searchResults: 8, searchBytes: 24_000 };
export interface BuildStatus {
  id: string; workspace: string;
  phase: "queued" | "indexing" | "saving" | "complete" | "failed" | "cancelled" | "interrupted";
  startedAt: number; finishedAt: number | null;
  completedFiles: number; totalFiles: number; currentSource?: string | null; error: string | null;
}
export interface BuildSnapshot {
  index: {
    workspace: string; built: boolean; files: number; symbols: number; refs: number;
    buildMs: number; skippedGenerated: number; skippedDirs: string[];
    cachePath: string; cacheBytes: number; reusedFiles: number;
  };
  settings: IndexSettings;
  job: BuildStatus | null;
}
export interface StoredIndex {
  projectId: string; workspace: string; bytes: number; updatedAt: number | null;
  building: boolean; workspaceExists: boolean;
}
export const isIndexBuilding = (job: BuildStatus | null | undefined): boolean =>
  !!job && ["queued", "indexing", "saving"].includes(job.phase);
export const readIndexBuild = (workspacePath: string): Promise<BuildSnapshot> =>
  invoke("code_index_build_status", { workspacePath });
export const saveIndexSettings = (workspacePath: string, settings: IndexSettings): Promise<void> =>
  invoke("code_index_save_settings", { workspacePath, settings });
export const cancelIndexBuild = (workspacePath: string): Promise<void> =>
  invoke("code_index_cancel_build", { workspacePath });
export const startIndexBuild = (workspacePath: string): Promise<BuildStatus> =>
  invoke("code_index_start_build", { workspacePath });
export const listIndexStorage = (): Promise<StoredIndex[]> => invoke("code_index_list_storage");
export const deleteIndexStorage = (projectId: string): Promise<void> => invoke("code_index_delete_storage", { projectId });
export const indexSize = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function buildProgress(job: BuildStatus): string {
  switch (job.phase) {
    case "queued": return "Waiting for another build to finish…";
    case "indexing": return job.totalFiles > 0
      ? `${job.completedFiles.toLocaleString()} of ${job.totalFiles.toLocaleString()} files checked.${job.currentSource ? ` ${job.currentSource}` : ""}`
      : "Reading project files…";
    case "saving": return "Saving the index…";
    case "complete": return "Code index updated.";
    case "cancelled": return "Build stopped. The previous saved index is kept.";
    case "interrupted": return "The app closed during this build. Rebuild to try again.";
    case "failed": return job.error ?? "The build failed. Rebuild to try again.";
  }
}
