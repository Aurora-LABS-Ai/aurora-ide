export interface ExplorerIconRequest {
  name: string;
  path?: string;
  isFolder: boolean;
  isOpen?: boolean;
}

export type ExplorerIconKind = "asset" | "aurora-folder" | "aurora-rules";

export type ExplorerIconPackId = string;

export interface ResolvedExplorerIcon {
  kind: ExplorerIconKind;
  alt: string;
  src?: string;
}

export interface ExplorerIconPackManifest {
  id: ExplorerIconPackId;
  name: string;
  description: string;
  author?: string;
  version?: string;
  source?: "built-in" | "custom";
}

export interface ExplorerIconPack {
  manifest: ExplorerIconPackManifest;
  resolveIcon: (request: ExplorerIconRequest) => ResolvedExplorerIcon;
}
