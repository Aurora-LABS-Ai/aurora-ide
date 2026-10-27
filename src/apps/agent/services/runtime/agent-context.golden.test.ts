/**
 * Golden files for the per-message context the window sends with a turn.
 *
 * `useAgentWindowSend` joins five blocks into `ideContext` (the runtime saves
 * it on the message as `aurora_context`): the open files, the inspector picks,
 * the `/`-attached rules, the `/`-named MCP servers and `/image`. Phase 3 moves
 * that into the engine; this records the exact text for each set of facts into
 * `src-tauri/src/agent_runtime/turn_build/golden/context/`, with the facts in
 * `cases.json`, for the Rust port (`turn_build/context.rs`) to match.
 *
 * The real builders are used. Rule files are pinned: the directory listing and
 * the file reads are mocked, and the Rust test writes the same files into a
 * temporary `.aurora/`.
 *
 * A deliberate change: run with `AURORA_UPDATE_GOLDEN=1` and commit the diff.
 */

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PickedElement } from "@/apps/agent/services/browser/browser-service";
import type { EngineMessageContext } from "@/apps/agent/services/runtime/agent-runtime-client";
import {
  buildImageRequest,
  buildMcpDirective,
  buildOpenFilesContext,
  buildRuleContext,
  joinContextBlocks,
} from "@/apps/agent/hooks/conversation/send/context-blocks";
import { buildSelectionContext } from "@/apps/agent/store/composer/useAgentSelectionStore";

const node = (globalThis as unknown as {
  process: { cwd: () => string; env: Record<string, string | undefined> };
}).process;
const GOLDEN_DIR = `${node.cwd()}/src-tauri/src/agent_runtime/turn_build/golden/context`;
const UPDATE = node.env.AURORA_UPDATE_GOLDEN === "1";

/** The `.aurora/*.md` files every case with a workspace has, in listing order. */
const RULES = [
  { filename: "a-tests.md", content: "\uFEFF  Run the tests before saying done.\n\n" },
  { filename: "b-style.md", content: "Tabs, not spaces.\nShort names." },
  { filename: "c-empty.md", content: "   \n" },
];
const WORKSPACE = "E:\\work\\shop";

vi.mock("@/kernel/lib/ipc/tauri", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDirectory: async (path: string) =>
    RULES.map((rule) => ({ name: rule.filename, path: `${path}\\${rule.filename}`, is_file: true })),
  readFileContent: async (path: string) => {
    const name = path.slice(path.lastIndexOf("\\") + 1);
    const rule = RULES.find((candidate) => candidate.filename === name);
    if (!rule) throw new Error(`no fixture rule ${name}`);
    return rule.content;
  },
}));

const element = (overrides: Partial<PickedElement>): PickedElement => ({
  label: "pick",
  selector: "main > div",
  tagName: "div",
  id: null,
  className: null,
  text: null,
  outerHtml: null,
  url: null,
  boundingRect: null,
  attributes: null,
  source: "inspector",
  note: null,
  ...overrides,
});

const FULL_PICK: PickedElement = element({
  selector: "#hero > button.cta",
  tagName: "button",
  id: "buy",
  className: "cta primary",
  text: "  Buy now\n  and save  " + "!".repeat(420),
  outerHtml: `<button id="buy" class="cta primary">${"x".repeat(2100)}</button>`,
  url: "http://localhost:5173/pricing",
  boundingRect: { x: 10.5, y: 20.49, width: 120.5, height: 39.5 },
  attributes: [
    { name: "id", value: "buy" },
    { name: "class", value: "cta primary" },
    ...Array.from({ length: 14 }, (_, i) => ({ name: `data-a${i}`, value: `v${i}` })),
  ],
  path: "main.flex-1 > section.hero",
  styles: [
    { name: "color", value: "rgb(255, 255, 255)" },
    { name: "font", value: "16px\n  Inter" },
  ],
  parent: "<section class=\"hero\">",
  siblings: ["<h1>Pricing</h1>", "<button class=\"cta primary\"><!-- SELECTED -->", "<a>Learn more</a>"],
  framework: "react",
  component: "PricingHero",
  props: [{ name: "plan", value: "pro" }],
});

const MINIMAL_PICK: PickedElement = element({
  text: "   ",
  id: "",
  boundingRect: { x: 0, y: 0, width: 0, height: 0 },
  framework: "vue",
  attributes: [],
  siblings: [],
});

interface ContextCase {
  name: string;
  facts: EngineMessageContext;
  attachedRuleFiles: string[];
  /** The case has a project (the rule fixture above is its `.aurora/`). */
  workspace: boolean;
}

const facts = (over: Partial<EngineMessageContext>): EngineMessageContext => ({
  openFiles: [],
  activeFile: null,
  pickedElements: [],
  mcpServerNames: [],
  imageRequested: false,
  ...over,
});

const CASES: ContextCase[] = [
  { name: "empty", facts: facts({}), attachedRuleFiles: [], workspace: true },
  {
    name: "open-files",
    facts: facts({
      openFiles: ["E:\\work\\shop\\src\\app.ts", "  E:\\work\\shop\\README.md ", "", "E:\\work\\shop\\src\\api.ts"],
      activeFile: "E:\\work\\shop\\src\\api.ts",
    }),
    attachedRuleFiles: [],
    workspace: true,
  },
  {
    name: "open-files-none-showing",
    facts: facts({ openFiles: ["E:\\work\\shop\\src\\app.ts"], activeFile: null }),
    attachedRuleFiles: [],
    workspace: true,
  },
  {
    name: "pick-full",
    facts: facts({ pickedElements: [{ index: 1, element: FULL_PICK }] }),
    attachedRuleFiles: [],
    workspace: true,
  },
  {
    name: "pick-minimal-two",
    facts: facts({
      pickedElements: [
        { index: 1, element: MINIMAL_PICK },
        { index: 2, element: element({ tagName: "p", text: "Hello", url: "" }) },
      ],
    }),
    attachedRuleFiles: [],
    workspace: true,
  },
  { name: "rules", facts: facts({}), attachedRuleFiles: ["b-style.md", "a-tests.md"], workspace: true },
  { name: "rules-empty-file", facts: facts({}), attachedRuleFiles: ["c-empty.md"], workspace: true },
  { name: "rules-none-match", facts: facts({}), attachedRuleFiles: ["zzz.md"], workspace: true },
  { name: "rules-no-workspace", facts: facts({}), attachedRuleFiles: ["a-tests.md"], workspace: false },
  {
    name: "mcp-image",
    facts: facts({ mcpServerNames: ["GitHub", "Postgres"], imageRequested: true }),
    attachedRuleFiles: [],
    workspace: true,
  },
  {
    name: "everything",
    facts: facts({
      openFiles: ["E:\\work\\shop\\src\\app.ts"],
      activeFile: "E:\\work\\shop\\src\\app.ts",
      pickedElements: [{ index: 1, element: FULL_PICK }],
      mcpServerNames: ["GitHub"],
      imageRequested: true,
    }),
    attachedRuleFiles: ["a-tests.md"],
    workspace: true,
  },
];

/** Exactly what `useAgentWindowSend` sends as `ideContext`. */
async function compose(c: ContextCase): Promise<string | null> {
  return joinContextBlocks([
    buildOpenFilesContext(c.facts.openFiles, c.facts.activeFile),
    buildSelectionContext(
      c.facts.pickedElements.map((pick) => ({ id: `pick-${pick.index}`, ...pick })),
    ),
    await buildRuleContext(c.workspace ? WORKSPACE : null, c.attachedRuleFiles),
    buildMcpDirective(c.facts.mcpServerNames),
    buildImageRequest(c.facts.imageRequested),
  ]);
}

describe("message context golden files", () => {
  beforeAll(() => {
    if (!UPDATE) return;
    mkdirSync(GOLDEN_DIR, { recursive: true });
    const cases = CASES.map((c) => ({
      name: c.name,
      facts: c.facts,
      attachedRuleFiles: c.attachedRuleFiles,
      workspace: c.workspace,
    }));
    writeFileSync(
      `${GOLDEN_DIR}/cases.json`,
      `${JSON.stringify({ rules: RULES, cases }, null, 2)}\n`,
      "utf8",
    );
  });

  it.each(CASES)("$name", async (c) => {
    // `null` (no context at all) is recorded as an empty file.
    const text = (await compose(c)) ?? "";
    const file = `${GOLDEN_DIR}/${c.name}.txt`;
    if (UPDATE) {
      writeFileSync(file, text, "utf8");
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(text).toBe(readFileSync(file, "utf8"));
  });

  it("the full pick is cut where the window cuts it", async () => {
    const text = (await compose(CASES.find((c) => c.name === "pick-full")!)) ?? "";
    expect(text).toContain(`${"x".repeat(2000 - '<button id="buy" class="cta primary">'.length)}… [cut]`);
    expect(text).toContain("size: 121×40 at x=11, y=20");
    expect(text).not.toContain("data-a12=");
  });
});
