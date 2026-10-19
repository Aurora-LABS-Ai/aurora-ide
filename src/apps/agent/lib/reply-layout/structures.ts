/** Structured explanations. Parsers never infer missing cells, states or parents. */
import { MAX_ITEMS, splitFields, titleAndRows } from "./fields";

export const CHECKLIST_STATUSES = {
  todo: "Pending",
  doing: "In progress",
  done: "Done",
  blocked: "Blocked",
} as const;

export type ChecklistStatus = keyof typeof CHECKLIST_STATUSES;

export interface ComparisonRow {
  label: string;
  values: string[];
}

export interface ChecklistItem {
  status: ChecklistStatus;
  title: string;
  caption?: string;
}

export interface TimelineItem {
  when: string;
  title: string;
  caption?: string;
}

export interface TreeNode {
  title: string;
  caption?: string;
  children: TreeNode[];
}

export type StructuredLayout =
  | { kind: "compare"; title: string; heading: string; options: string[]; rows: ComparisonRow[]; problems: string[] }
  | { kind: "checklist"; title: string; items: ChecklistItem[]; problems: string[] }
  | { kind: "timeline"; title: string; items: TimelineItem[]; problems: string[] }
  | { kind: "tree"; title: string; nodes: TreeNode[]; problems: string[] };

type StructureKind = StructuredLayout["kind"];
const MAX_OPTIONS = 4;
const MAX_TREE_DEPTH = 4;

function parseComparison(lines: string[]): StructuredLayout {
  const { title, rows: sourceRows } = titleAndRows(lines);
  const [header = "", ...body] = sourceRows;
  const [heading = "", ...options] = splitFields(header);
  const rows: ComparisonRow[] = [];
  const problems: string[] = [];
  if (!heading || options.length < 2 || options.length > MAX_OPTIONS || options.some((option) => !option)) {
    if (header) problems.push(`${header}: start with "Aspect | Option A | Option B", with two to ${MAX_OPTIONS} named options`);
    return { kind: "compare", title, heading, options: [], rows, problems };
  }
  for (const line of body) {
    const [label, ...values] = splitFields(line);
    if (!label || values.length !== options.length || values.some((value) => !value)) {
      problems.push(`${line}: name the aspect and supply one value for each of the ${options.length} options`);
    } else if (rows.length >= MAX_ITEMS) {
      problems.push(`${line}: more than ${MAX_ITEMS} comparison rows`);
    } else {
      rows.push({ label, values });
    }
  }
  return { kind: "compare", title, heading, options, rows, problems };
}

function parseChecklist(lines: string[]): StructuredLayout {
  const { title, rows } = titleAndRows(lines);
  const items: ChecklistItem[] = [];
  const problems: string[] = [];
  for (const line of rows) {
    const [status = "", label = "", caption = "", ...extra] = splitFields(line);
    if (!Object.prototype.hasOwnProperty.call(CHECKLIST_STATUSES, status) || !label || extra.length > 0) {
      problems.push(`${line}: use "Status | Item | Optional detail"; status must be todo, doing, done or blocked`);
    } else if (items.length >= MAX_ITEMS) {
      problems.push(`${line}: more than ${MAX_ITEMS} checklist items`);
    } else {
      items.push({ status: status as ChecklistStatus, title: label, ...(caption ? { caption } : {}) });
    }
  }
  return { kind: "checklist", title, items, problems };
}

function parseTimeline(lines: string[]): StructuredLayout {
  const { title, rows } = titleAndRows(lines);
  const items: TimelineItem[] = [];
  const problems: string[] = [];
  for (const line of rows) {
    const [when = "", label = "", caption = "", ...extra] = splitFields(line);
    if (!when || !label || extra.length > 0) {
      problems.push(`${line}: an event is "Date or period | Event | Optional detail"`);
    } else if (items.length >= MAX_ITEMS) {
      problems.push(`${line}: more than ${MAX_ITEMS} timeline events`);
    } else {
      items.push({ when, title: label, ...(caption ? { caption } : {}) });
    }
  }
  return { kind: "timeline", title, items, problems };
}

function parseTree(lines: string[]): StructuredLayout {
  const { title, rows } = titleAndRows(lines);
  const nodes: TreeNode[] = [];
  const parents: TreeNode[] = [];
  const problems: string[] = [];
  let count = 0;
  for (const line of rows) {
    const [level = "", label = "", caption = "", ...extra] = splitFields(line);
    const depth = Number(level);
    const validDepth = /^\d$/.test(level) && depth <= MAX_TREE_DEPTH;
    if (!validDepth || depth > parents.length || !label || extra.length > 0) {
      problems.push(`${line}: use "Depth | Item | Optional detail", starting at 0, increasing by at most one, up to ${MAX_TREE_DEPTH}`);
      // A rejected parent must not attach its children to an earlier sibling.
      parents.length = validDepth ? Math.min(parents.length, depth) : 0;
      continue;
    }
    if (count >= MAX_ITEMS) {
      problems.push(`${line}: more than ${MAX_ITEMS} tree items`);
      continue;
    }
    const node: TreeNode = { title: label, ...(caption ? { caption } : {}), children: [] };
    if (depth === 0) nodes.push(node);
    else parents[depth - 1].children.push(node);
    parents.length = depth;
    parents.push(node);
    count += 1;
  }
  return { kind: "tree", title, nodes, problems };
}

export function parseStructure(kind: StructureKind, lines: string[]): StructuredLayout {
  switch (kind) {
    case "compare": return parseComparison(lines);
    case "checklist": return parseChecklist(lines);
    case "timeline": return parseTimeline(lines);
    case "tree": return parseTree(lines);
  }
}
