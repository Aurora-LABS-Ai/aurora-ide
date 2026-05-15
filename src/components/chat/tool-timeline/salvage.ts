import type { GrepData, GrepMatch, WorkspaceTreeData, WorkspaceTreeNode } from "./types";

/**
 * Truncated-result salvage.
 *
 * The Rust runtime caps each tool result at 8 KiB before pushing it
 * into the conversation history / JSONL log. Live tool calls bypass
 * that cap (we forward the full payload to the UI event), but a
 * thread reloaded from disk sees only the truncated copy and
 * `JSON.parse` chokes on the clipped tail. This module attempts a
 * best-effort recovery for tools we know return JSON, so historical
 * chat threads render a partial tree / grep view instead of dumping
 * the raw clipped bytes as plaintext.
 */

export interface SalvageResult {
  workspaceTree?: WorkspaceTreeData;
  grep?: GrepData;
  message?: string;
}

const TRUNCATION_MARKER = "\n\n[truncated";

function stripTruncationMarker(s: string): string {
  const idx = s.indexOf(TRUNCATION_MARKER);
  return idx >= 0 ? s.slice(0, idx) : s;
}

/**
 * Close dangling `{` / `[` brackets in left-to-right order so a
 * clipped JSON string round-trips through `JSON.parse`. Bails when
 * the cut lands inside a `"..."` — there's no safe way to guess
 * where the string was meant to end.
 */
function repairTruncatedJson(head: string): string | null {
  let trimmed = head.replace(/[\s,]+$/u, "");
  if (!trimmed) return null;

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}") {
      if (stack[stack.length - 1] === "{") stack.pop();
    } else if (ch === "]") {
      if (stack[stack.length - 1] === "[") stack.pop();
    }
  }
  if (inString) return null;

  // Lop off a dangling `"key":` that would otherwise become invalid
  // when we close brackets directly after the colon.
  trimmed = trimmed.replace(/[,\s]*"[^"]*"\s*:\s*$/u, "");
  trimmed = trimmed.replace(/[,\s]+$/u, "");

  let suffix = "";
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    suffix += stack[i] === "{" ? "}" : "]";
  }
  return trimmed + suffix;
}

export function salvageTruncatedToolResult(
  toolName: string,
  raw: string,
): SalvageResult | null {
  if (!raw || !raw.includes("[truncated")) return null;

  if (toolName === "workspace_tree") {
    const head = stripTruncationMarker(raw);
    const repaired = repairTruncatedJson(head);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        if (Array.isArray(parsed?.tree)) {
          return {
            workspaceTree: {
              rootPath:
                typeof parsed.rootPath === "string" ? parsed.rootPath : undefined,
              tree: parsed.tree as WorkspaceTreeNode[],
              stats: parsed.stats,
            },
            message: "partial tree (truncated)",
          };
        }
      } catch {
        // fall through to plain notice
      }
    }
    return { message: "Result truncated — re-run to inspect" };
  }

  if (toolName === "grep") {
    const head = stripTruncationMarker(raw);
    const repaired = repairTruncatedJson(head);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        if (Array.isArray(parsed?.matches)) {
          return {
            grep: {
              matches: parsed.matches as GrepMatch[],
              pattern:
                typeof parsed.pattern === "string" ? parsed.pattern : undefined,
              totalMatches:
                typeof parsed.total_matches === "number"
                  ? parsed.total_matches
                  : undefined,
              truncated: true,
            },
            message: "partial matches (truncated)",
          };
        }
      } catch {
        // fall through
      }
    }
    return { message: "Result truncated — re-run to inspect" };
  }

  return { message: "Result truncated" };
}
