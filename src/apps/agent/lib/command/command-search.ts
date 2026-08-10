export interface SearchableCommand {
  title: string;
  subtitle?: string;
  keywords?: string;
  group: string;
}

export function fuzzyCommandScore(item: SearchableCommand, query: string): number {
  const haystack = `${item.title} ${item.subtitle ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
  const title = item.title.toLowerCase();
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  let total = 0;
  for (const token of tokens) {
    const direct = haystack.indexOf(token);
    if (direct >= 0) {
      total += 100 - Math.min(direct, 60) + (title.startsWith(token) ? 80 : 0);
      continue;
    }
    let cursor = 0;
    let gaps = 0;
    for (const char of token) {
      const found = haystack.indexOf(char, cursor);
      if (found < 0) return -1;
      gaps += found - cursor;
      cursor = found + 1;
    }
    total += Math.max(5, 45 - gaps);
  }
  return total;
}
