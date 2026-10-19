/** Line and field rules shared by every reply layout parser. */
export const MAX_ITEMS = 12;

/** Split unescaped pipes, retaining empty fields. */
export function splitFields(line: string, separator: "|" | "||" = "|"): string[] {
  const out: string[] = [];
  let field = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      // Flow fields are split a second time on single pipes.
      field += separator === "||" ? "\\|" : "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (separator === "||") {
        if (line[i + 1] !== "|") {
          field += ch;
          continue;
        }
        i += 1;
      }
      out.push(field.trim());
      field = "";
      continue;
    }
    field += ch;
  }
  out.push(field.trim());
  return out;
}

/** A trailing line without its newline is incomplete until the fence closes. */
export function usableLines(source: string, closed: boolean): string[] {
  const lines = source.split("\n");
  if (!closed && !source.endsWith("\n")) lines.pop();
  return lines.map((line) => line.trim()).filter(Boolean);
}

/** A first line without a field separator is an optional title. */
export function titleAndRows(lines: string[]): { title: string; rows: string[] } {
  const [first = "", ...rest] = lines;
  return first && splitFields(first).length === 1 ? { title: first, rows: rest } : { title: "", rows: lines };
}
