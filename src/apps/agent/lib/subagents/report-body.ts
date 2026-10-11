/**
 * A sub-agent's report, as prose.
 *
 * The model reads the whole `<subagent_report …>` envelope: the usage line,
 * the transcript path, the continue hint. The person reads what the child
 * wrote. This strips the machinery and keeps the words.
 */

export interface ReportBody {
  /** What the child wrote, summary first. Markdown. */
  body: string;
  /** `1m 31s · 12 tool calls · 8421 tokens`, when the envelope carried it. */
  meta: string | null;
  /**
   * How far it got, as it said with `submit_report`: `done`, `partial`,
   * `blocked`, or `not_submitted` when it never handed a report in. `null`
   * for a mid-run message and for reports from before `submit_report`.
   */
  outcome: string | null;
}

/**
 * A submitted report arrives as labelled lines for the model:
 *
 *   Outcome: partial
 *   Summary: Login is in src/auth.ts:42; logout is not wired.
 *   Changed files: src/auth.ts
 *
 *   Report:
 *   …
 *
 * The person reads the summary first (the card's lead is the first
 * paragraph), the changed files after it, then the report. Labels go;
 * `done` goes without saying; `partial` and `blocked` lead the summary.
 */
export function reportBody(detail: string): ReportBody {
  let text = detail.trim();
  const outcome = /^<subagent_report[^>]*\soutcome="([a-z_]+)"/i.exec(text)?.[1] ?? null;
  // A finish report (`<subagent_report>`) or a mid-run message
  // (`<subagent_message>`): same envelope shape, same stripping.
  text = text
    .replace(/^<subagent_(?:report|message)[^>]*>\s*/i, "")
    .replace(/\s*<\/subagent_(?:report|message)>\s*$/i, "");
  const lines = text.split("\n");
  // First line of a report: `Sub-agent "…" completed after 1m 31s · 12 tool
  // calls · 8421 tokens.` First line of a message: `Sub-agent "…" is still
  // working and says:` — machinery either way.
  const metaLine = lines[0]?.startsWith("Sub-agent ") ? (lines.shift() ?? null) : null;
  const meta =
    metaLine && / after /.test(metaLine)
      ? metaLine.replace(/^Sub-agent\s+"[^"]*"\s+\w+\s+after\s+/, "").replace(/\.$/, "")
      : null;

  let summary: string | null = null;
  let changed: string | null = null;
  // Past the `Report:` / `Last message:` label everything is the child's own
  // text, kept as written even where a line happens to start with a label.
  let inBody = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^Transcript:\s/.test(line)) continue;
    if (/^To continue this agent/.test(line)) continue;
    if (/^It cannot ask the user\. Answer it with send_message/.test(line)) continue;
    if (/^This is a conversation reply, not a new work report\./.test(line)) continue;
    if (!inBody) {
      if (/^(?:Report|Last message):\s*$/i.test(line)) {
        inBody = true;
        continue;
      }
      if (/^Outcome:\s*[a-z_]+\s*$/i.test(line)) continue;
      const s = /^Summary:\s*(.*)$/.exec(line);
      if (s && summary === null) {
        summary = s[1].trim();
        continue;
      }
      const c = /^Changed files:\s*(.*)$/.exec(line);
      if (c && changed === null) {
        changed = c[1].trim();
        continue;
      }
    }
    kept.push(line);
  }

  const parts: string[] = [];
  if (summary) {
    const lead = outcome === "partial" ? "Partial. " : outcome === "blocked" ? "Blocked. " : "";
    parts.push(`${lead}${summary}`);
  }
  if (changed) parts.push(`Changed files: ${changed}`);
  // Reports written before labels existed put `Report:` on the first line.
  const rest = kept.join("\n").trim().replace(/^Report:\s*/i, "");
  if (rest) parts.push(rest);
  return { body: parts.join("\n\n"), meta, outcome };
}

/** The first paragraph of a report — what the card shows before "Open report". */
export function reportLead(body: string): string {
  return body.split(/\n\s*\n/)[0]?.trim() ?? "";
}
