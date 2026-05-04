/**
 * Native editor-ops bindings.
 *
 * These call into the Rust commands defined in `src-tauri/src/commands/editor_ops.rs`,
 * which collapse multi-step JS workflows (read → manipulate string → write → diff)
 * into single IPC calls executed entirely in Rust. Use these whenever you would
 * otherwise read a file, mutate its content in TypeScript, and write it back.
 *
 * All read paths share the same Rust file cache as `read_file_content`, so
 * cache hits are essentially free.
 */

import { auroraInvoke, isAuroraRuntimeAvailable } from "./runtime";

export interface NativeReplacementItem {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface NativeReplacementDetail {
  index: number;
  occurrences: number;
  replaced: number;
}

export type NativeSearchReplaceResponse =
  | {
      status: "ok";
      originalContent: string;
      newContent: string;
      lineEndingNormalized: boolean;
      linesAdded: number;
      linesRemoved: number;
      totalReplacements: number;
      replacementDetails: NativeReplacementDetail[];
      wroteToDisk: boolean;
    }
  | {
      status: "not_found";
      failedAt: number;
    }
  | {
      status: "not_unique";
      failedAt: number;
      occurrences: number;
    }
  | {
      status: "overlap";
      failedAt: number;
      conflictingReplacement: number;
    };

export interface ApplySearchReplaceArgs {
  path: string;
  replacement: NativeReplacementItem;
  /** Persist the new content to disk in the same call. Default false. */
  write?: boolean;
}

export interface ApplyMultiSearchReplaceArgs {
  path: string;
  replacements: NativeReplacementItem[];
  write?: boolean;
}

const ensureRuntime = (op: string) => {
  if (!isAuroraRuntimeAvailable()) {
    throw new Error(`${op} requires the Aurora desktop runtime`);
  }
};

const toRustReplacement = (item: NativeReplacementItem) => ({
  oldString: item.oldString,
  newString: item.newString,
  replaceAll: item.replaceAll === true,
});

/** Single-snippet find/replace executed entirely in Rust. */
export const applySearchReplaceNative = async (
  args: ApplySearchReplaceArgs,
): Promise<NativeSearchReplaceResponse> => {
  ensureRuntime("applySearchReplaceNative");
  return auroraInvoke<NativeSearchReplaceResponse>("apply_search_replace", {
    request: {
      path: args.path,
      replacement: toRustReplacement(args.replacement),
      write: args.write === true,
    },
  });
};

/** Atomic batch find/replace executed entirely in Rust. */
export const applyMultiSearchReplaceNative = async (
  args: ApplyMultiSearchReplaceArgs,
): Promise<NativeSearchReplaceResponse> => {
  ensureRuntime("applyMultiSearchReplaceNative");
  return auroraInvoke<NativeSearchReplaceResponse>("apply_multi_search_replace", {
    request: {
      path: args.path,
      replacements: args.replacements.map(toRustReplacement),
      write: args.write === true,
    },
  });
};

export interface NativeUnifiedDiffArgs {
  original: string;
  modified: string;
  contextLines?: number;
  originalLabel?: string;
  modifiedLabel?: string;
}

export interface NativeUnifiedDiffResponse {
  diff: string;
  additions: number;
  deletions: number;
  identical: boolean;
}

/** Compute a unified diff using the `similar` crate on the Rust side. */
export const computeUnifiedDiffNative = async (
  args: NativeUnifiedDiffArgs,
): Promise<NativeUnifiedDiffResponse> => {
  ensureRuntime("computeUnifiedDiffNative");
  return auroraInvoke<NativeUnifiedDiffResponse>("compute_unified_diff", {
    request: {
      original: args.original,
      modified: args.modified,
      contextLines: args.contextLines ?? 3,
      originalLabel: args.originalLabel,
      modifiedLabel: args.modifiedLabel,
    },
  });
};

export interface NativeSliceFileLinesArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
}

export interface NativeSliceFileLinesResponse {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  byteSize: number;
  truncated: boolean;
}

/** Read + slice a file's lines server-side so we never ship the full body to JS. */
export const sliceFileLinesNative = async (
  args: NativeSliceFileLinesArgs,
): Promise<NativeSliceFileLinesResponse> => {
  ensureRuntime("sliceFileLinesNative");
  return auroraInvoke<NativeSliceFileLinesResponse>("slice_file_lines", {
    request: {
      path: args.path,
      startLine: args.startLine,
      endLine: args.endLine,
      maxLines: args.maxLines,
    },
  });
};

export interface NativeIsPathExcludedItem {
  path: string;
  excluded: boolean;
  reason?: string;
}

export interface NativeIsPathExcludedResponse {
  results: NativeIsPathExcludedItem[];
}

/** Native exclusion check; uses the same allow-list as the TS implementation. */
export const isPathExcludedNative = async (
  pathOrPaths: string | string[],
): Promise<NativeIsPathExcludedResponse> => {
  ensureRuntime("isPathExcludedNative");
  if (Array.isArray(pathOrPaths)) {
    return auroraInvoke<NativeIsPathExcludedResponse>("is_path_excluded", {
      request: { path: "", paths: pathOrPaths },
    });
  }
  return auroraInvoke<NativeIsPathExcludedResponse>("is_path_excluded", {
    request: { path: pathOrPaths },
  });
};
