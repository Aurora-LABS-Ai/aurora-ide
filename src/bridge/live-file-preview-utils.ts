import { parseToolArguments } from "@/kernel/lib/llm/tool-arguments";
import type { SearchReplaceReplacement } from "@/kernel/lib/fs/search-replace-utils";

export type LivePreviewToolName =
  | "file_write"
  | "file_edit"
  // Legacy names kept so historical threads (and any in-flight call from
  // an older session) still resolve. New sessions only emit the two above.
  | "file_create"
  | "search_replace"
  | "multi_search_replace";

export interface StreamingStringField {
  complete: boolean;
  value: string;
}

const TRUE_FIELD_PATTERN = (field: string) =>
  new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*true`);

export const isLivePreviewTool = (toolName: string): toolName is LivePreviewToolName => {
  return (
    toolName === "file_write" ||
    toolName === "file_edit" ||
    // Legacy aliases (historical threads).
    toolName === "file_create" ||
    toolName === "search_replace" ||
    toolName === "multi_search_replace"
  );
};

export const extractStreamingStringField = (
  rawArguments: string | null | undefined,
  field: string,
  options: { preservePathBackslashes?: boolean } = {},
): StreamingStringField | null => {
  const raw = rawArguments ?? "";
  const fieldPattern = new RegExp(
    `"${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`,
  );
  const match = fieldPattern.exec(raw);
  if (!match) {
    return null;
  }

  let value = "";
  let escaped = false;
  const startIndex = match.index + match[0].length;

  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];

    if (escaped) {
      if (options.preservePathBackslashes) {
        value += char === "\\" ? "\\" : `\\${char}`;
        escaped = false;
        continue;
      }

      switch (char) {
        case '"':
        case "\\":
        case "/":
          value += char;
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "u": {
          const hex = raw.slice(index + 1, index + 5);
          if (hex.length < 4) {
            return { value, complete: false };
          }
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(parseInt(hex, 16));
            index += 4;
          } else {
            value += `\\u${hex}`;
            index += hex.length;
          }
          break;
        }
        default:
          value += `\\${char}`;
          break;
      }
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return { value, complete: true };
    }

    value += char;
  }

  if (escaped) {
    value += "\\";
  }

  return { value, complete: false };
};

export const getStreamingStringArg = (
  rawArguments: string,
  field: string,
): StreamingStringField | null => {
  if (field === "path") {
    const pathField = extractStreamingStringField(rawArguments, field, {
      preservePathBackslashes: true,
    });
    if (pathField) {
      return pathField;
    }
  }

  const parsed = parseToolArguments(rawArguments);
  const parsedValue = parsed.status !== "invalid" ? parsed.args[field] : undefined;
  if (typeof parsedValue === "string") {
    return { value: parsedValue, complete: true };
  }

  return extractStreamingStringField(rawArguments, field);
};

export const getStreamingBooleanArg = (
  rawArguments: string,
  field: string,
): boolean => {
  const parsed = parseToolArguments(rawArguments);
  const parsedValue = parsed.status !== "invalid" ? parsed.args[field] : undefined;
  if (typeof parsedValue === "boolean") {
    return parsedValue;
  }

  return TRUE_FIELD_PATTERN(field).test(rawArguments);
};

export const getParsedReplacementsArg = (
  rawArguments: string,
): SearchReplaceReplacement[] | null => {
  const parsed = parseToolArguments(rawArguments);
  if (parsed.status === "invalid") {
    return null;
  }

  // `file_edit` uses `edits`; the legacy `multi_search_replace` used
  // `replacements`. Accept either so both old and new calls preview.
  const replacements = Array.isArray(parsed.args.edits)
    ? parsed.args.edits
    : parsed.args.replacements;
  if (!Array.isArray(replacements)) {
    return null;
  }

  const validReplacements = replacements.filter(
    (replacement): replacement is SearchReplaceReplacement => {
      if (typeof replacement !== "object" || replacement === null) {
        return false;
      }
      const record = replacement as Record<string, unknown>;
      return (
        typeof record.old_string === "string" &&
        typeof record.new_string === "string" &&
        (record.replace_all === undefined || typeof record.replace_all === "boolean")
      );
    },
  );

  return validReplacements.length === replacements.length ? validReplacements : null;
};
