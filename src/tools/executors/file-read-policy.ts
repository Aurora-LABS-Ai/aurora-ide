export const LARGE_FILE_LINE_THRESHOLD = 1_500;
export const MAX_SINGLE_READ_LINES = 1_000;
export const DEFAULT_LINE_WINDOW = 250;

export interface FileReadRangeRequest {
  endLine?: unknown;
  maxLines?: unknown;
  startLine?: unknown;
}

export interface NormalizedLineRange {
  endLine: number;
  explicit: boolean;
  startLine: number;
}

export interface LineRangeResult {
  content: string;
  endLine: number;
  omittedLinesAfter: number;
  omittedLinesBefore: number;
  startLine: number;
  truncated: boolean;
}

export const splitLines = (content: string): string[] => {
  if (content.length === 0) {
    return [];
  }

  return content.split(/\r\n|\n|\r/);
};

const toPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
};

export const normalizeLineRange = (
  request: FileReadRangeRequest,
  totalLines: number,
): NormalizedLineRange | null => {
  const requestedStart = toPositiveInteger(request.startLine);
  const requestedEnd = toPositiveInteger(request.endLine);
  const requestedMaxLines = toPositiveInteger(request.maxLines);
  const explicit = requestedStart !== undefined || requestedEnd !== undefined;

  if (!explicit && totalLines <= LARGE_FILE_LINE_THRESHOLD) {
    return null;
  }

  const startLine = Math.min(Math.max(requestedStart ?? 1, 1), Math.max(totalLines, 1));
  const requestedWindow =
    requestedMaxLines ?? (explicit ? MAX_SINGLE_READ_LINES : DEFAULT_LINE_WINDOW);
  const boundedWindow = Math.min(requestedWindow, MAX_SINGLE_READ_LINES);
  const naturalEndLine = requestedEnd ?? startLine + boundedWindow - 1;
  const endLine = Math.min(
    Math.max(naturalEndLine, startLine),
    startLine + boundedWindow - 1,
    Math.max(totalLines, 1),
  );

  return {
    endLine,
    explicit,
    startLine,
  };
};

export const sliceLineRange = (
  lines: string[],
  range: NormalizedLineRange,
): LineRangeResult => {
  const totalLines = lines.length;
  const selectedLines = lines.slice(range.startLine - 1, range.endLine);
  const omittedLinesBefore = Math.max(range.startLine - 1, 0);
  const omittedLinesAfter = Math.max(totalLines - range.endLine, 0);

  return {
    content: selectedLines.join("\n"),
    endLine: range.endLine,
    omittedLinesAfter,
    omittedLinesBefore,
    startLine: range.startLine,
    truncated: omittedLinesBefore > 0 || omittedLinesAfter > 0,
  };
};

export const isLargeFileByLines = (totalLines: number): boolean =>
  totalLines > LARGE_FILE_LINE_THRESHOLD;
