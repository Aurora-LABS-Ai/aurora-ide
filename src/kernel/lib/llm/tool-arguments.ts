/**
 * Tool argument parsing utilities
 *
 * Some providers occasionally stream malformed JSON argument strings
 * (most commonly unescaped Windows path backslashes). These helpers
 * make parsing resilient while preserving strict failure signaling.
 */

type ToolArgumentsParseStatus = 'parsed' | 'repaired' | 'invalid';

export interface ToolArgumentsParseResult {
  args: Record<string, unknown>;
  error?: Error;
  raw: string;
  repairedRaw?: string;
  status: ToolArgumentsParseStatus;
}

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
const HEX_REGEX = /^[0-9a-fA-F]{4}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseJsonAsRecord = (json: string): Record<string, unknown> => {
  const parsed = JSON.parse(json) as unknown;
  if (isRecord(parsed)) {
    return parsed;
  }
  throw new Error('Tool arguments must be a JSON object');
};

const isValidUnicodeEscape = (json: string, backslashIndex: number): boolean => {
  const hex = json.slice(backslashIndex + 2, backslashIndex + 6);
  return hex.length === 4 && HEX_REGEX.test(hex);
};

const repairInvalidBackslashesInJsonStrings = (json: string): string => {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (!inString) {
      result += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      const nextChar = json[i + 1];

      if (!nextChar) {
        result += '\\\\';
        continue;
      }

      const validEscapeChar = VALID_JSON_ESCAPES.has(nextChar);
      const validUnicode = nextChar !== 'u' || isValidUnicodeEscape(json, i);

      if (validEscapeChar && validUnicode) {
        result += '\\';
        escaped = true;
      } else {
        // Convert invalid "\" into a literal backslash sequence.
        result += '\\\\';
      }
      continue;
    }

    if (char === '"') {
      inString = false;
    }

    result += char;
  }

  return result;
};

export const parseToolArguments = (
  rawArguments: string | null | undefined
): ToolArgumentsParseResult => {
  const raw = (rawArguments ?? '').trim();

  if (!raw) {
    return {
      args: {},
      raw,
      status: 'parsed',
    };
  }

  try {
    return {
      args: parseJsonAsRecord(raw),
      raw,
      status: 'parsed',
    };
  } catch (initialError) {
    const repairedRaw = repairInvalidBackslashesInJsonStrings(raw);

    if (repairedRaw !== raw) {
      try {
        return {
          args: parseJsonAsRecord(repairedRaw),
          raw,
          repairedRaw,
          status: 'repaired',
        };
      } catch (repairError) {
        return {
          args: {},
          error: repairError instanceof Error ? repairError : new Error(String(repairError)),
          raw,
          repairedRaw,
          status: 'invalid',
        };
      }
    }

    return {
      args: {},
      error: initialError instanceof Error ? initialError : new Error(String(initialError)),
      raw,
      status: 'invalid',
    };
  }
};

/**
 * Parse tool arguments for UI display/logging.
 * Returns `{ raw }` when arguments are malformed.
 */
export const parseToolArgumentsForDisplay = (
  rawArguments: string | null | undefined
): Record<string, unknown> => {
  const parsed = parseToolArguments(rawArguments);
  if (parsed.status === 'invalid') {
    return { raw: rawArguments ?? '' };
  }
  return parsed.args;
};
