export type LineEnding = "\n" | "\r\n";

export interface SearchReplacePlanFailure {
  failedAt?: number;
  conflictingReplacement?: number;
  occurrences?: number;
  reason: "not_found" | "not_unique" | "overlap";
  success: false;
}

export interface SearchReplacePlanSuccess {
  content: string;
  lineEndingNormalized: boolean;
  linesAdded: number;
  linesRemoved: number;
  occurrences: number;
  replacementDetails: ReplacementDetail[];
  success: true;
  totalReplacements: number;
}

export interface SearchReplaceReplacement {
  new_string: string;
  old_string: string;
  replace_all?: boolean;
}

export interface ReplacementDetail {
  index: number;
  occurrences: number;
  replaced: number;
}

interface PlannedRange {
  end: number;
  newText: string;
  replacementIndex: number;
  start: number;
}

const countOccurrences = (content: string, search: string): number => {
  let count = 0;
  let searchStart = 0;

  while (searchStart < content.length) {
    const matchIndex = content.indexOf(search, searchStart);
    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    searchStart = matchIndex + search.length;
  }

  return count;
};

const detectLineEnding = (content: string): LineEnding => {
  if (content.includes("\r\n")) {
    return "\r\n";
  }

  return "\n";
};

const findMatchRanges = (content: string, search: string): PlannedRange[] => {
  const matches: PlannedRange[] = [];
  let searchStart = 0;

  while (searchStart < content.length) {
    const matchIndex = content.indexOf(search, searchStart);
    if (matchIndex === -1) {
      return matches;
    }

    matches.push({
      start: matchIndex,
      end: matchIndex + search.length,
      newText: "",
      replacementIndex: 0,
    });
    searchStart = matchIndex + search.length;
  }

  return matches;
};

const hasOverlap = (existingRanges: PlannedRange[], candidateRange: PlannedRange): PlannedRange | null => {
  for (const existingRange of existingRanges) {
    const overlaps =
      candidateRange.start < existingRange.end &&
      candidateRange.end > existingRange.start;

    if (overlaps) {
      return existingRange;
    }
  }

  return null;
};

const normalizeLineEndings = (value: string): string => value.replace(/\r\n/g, "\n");

const restoreLineEndings = (content: string, lineEnding: LineEnding): string => {
  if (lineEnding === "\r\n") {
    return content.replace(/\n/g, "\r\n");
  }

  return content;
};

const textLineCount = (value: string): number => value.split("\n").length;

export const planSearchReplace = (
  originalContent: string,
  replacement: SearchReplaceReplacement,
): SearchReplacePlanFailure | SearchReplacePlanSuccess => {
  return planMultiSearchReplace(originalContent, [replacement]);
};

export const planMultiSearchReplace = (
  originalContent: string,
  replacements: SearchReplaceReplacement[],
): SearchReplacePlanFailure | SearchReplacePlanSuccess => {
  const originalLineEnding = detectLineEnding(originalContent);
  const normalizedOriginalContent = normalizeLineEndings(originalContent);
  const plannedRanges: PlannedRange[] = [];
  const replacementDetails: ReplacementDetail[] = [];
  let lineEndingNormalized = normalizedOriginalContent !== originalContent;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;
  let totalReplacements = 0;

  for (let index = 0; index < replacements.length; index += 1) {
    const replacement = replacements[index];
    const normalizedOldString = normalizeLineEndings(replacement.old_string);
    const normalizedNewString = normalizeLineEndings(replacement.new_string);
    const replaceAll = replacement.replace_all === true;

    if (
      normalizedOldString !== replacement.old_string ||
      normalizedNewString !== replacement.new_string
    ) {
      lineEndingNormalized = true;
    }

    const occurrences = countOccurrences(normalizedOriginalContent, normalizedOldString);
    if (occurrences === 0) {
      return {
        success: false,
        reason: "not_found",
        failedAt: index + 1,
      };
    }

    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        reason: "not_unique",
        failedAt: index + 1,
        occurrences,
      };
    }

    const matchedRanges = findMatchRanges(normalizedOriginalContent, normalizedOldString);
    const selectedRanges = replaceAll ? matchedRanges : matchedRanges.slice(0, 1);

    for (const matchedRange of selectedRanges) {
      const plannedRange: PlannedRange = {
        start: matchedRange.start,
        end: matchedRange.end,
        newText: normalizedNewString,
        replacementIndex: index + 1,
      };

      const conflictingRange = hasOverlap(plannedRanges, plannedRange);
      if (conflictingRange) {
        return {
          success: false,
          reason: "overlap",
          failedAt: index + 1,
          conflictingReplacement: conflictingRange.replacementIndex,
        };
      }

      plannedRanges.push(plannedRange);
    }

    const replacedCount = replaceAll ? occurrences : 1;
    totalLinesRemoved += textLineCount(normalizedOldString) * replacedCount;
    totalLinesAdded += textLineCount(normalizedNewString) * replacedCount;
    totalReplacements += replacedCount;
    replacementDetails.push({
      index: index + 1,
      occurrences,
      replaced: replacedCount,
    });
  }

  const appliedContent = [...plannedRanges]
    .sort((left, right) => right.start - left.start)
    .reduce((content, plannedRange) => {
      return (
        content.slice(0, plannedRange.start) +
        plannedRange.newText +
        content.slice(plannedRange.end)
      );
    }, normalizedOriginalContent);

  return {
    success: true,
    content: restoreLineEndings(appliedContent, originalLineEnding),
    occurrences: replacementDetails[0]?.occurrences ?? 0,
    lineEndingNormalized,
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    replacementDetails,
    totalReplacements,
  };
};
