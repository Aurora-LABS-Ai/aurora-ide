import { describe, expect, it } from "vitest";

import { describeToolActivity, type AgentActivity } from "./activity";

const cases: Array<{
  tool: string;
  args: string;
  activity: AgentActivity;
}> = [
  {
    tool: "file_write",
    args: '{"path":"src/index.html","content":"<main',
    activity: {
      label: "Writing index.html",
      verb: "Writing",
      name: "index.html",
      path: "src/index.html",
      kind: "file",
      targets: [{ name: "index.html", path: "src/index.html", kind: "file" }],
    },
  },
  {
    tool: "file_edit",
    args: '{"edits":[{"path":"src/App.tsx","old_string":"old","new_string":"new',
    activity: {
      label: "Editing App.tsx",
      verb: "Editing",
      name: "App.tsx",
      path: "src/App.tsx",
      kind: "file",
      targets: [{ name: "App.tsx", path: "src/App.tsx", kind: "file" }],
    },
  },
  {
    tool: "file_read",
    args: '{"paths":["src/a.ts","src/b.ts"],"start_line":',
    activity: {
      label: "Reading a.ts +1",
      verb: "Reading",
      name: "a.ts +1",
      path: "src/a.ts",
      kind: "file",
      targets: [
        { name: "a.ts", path: "src/a.ts", kind: "file" },
        { name: "b.ts", path: "src/b.ts", kind: "file" },
      ],
    },
  },
  {
    tool: "move_path",
    args: '{"old_path":"src/old.js","new_path":"src/new.js',
    activity: {
      label: "Moving old.js",
      verb: "Moving",
      name: "old.js",
      path: "src/old.js",
      kind: "file",
      targets: [{ name: "old.js", path: "src/old.js", kind: "file" }],
    },
  },
  {
    tool: "workspace_tree",
    args: '{"path":"src/components","depth":',
    activity: {
      label: "Inspecting components",
      verb: "Inspecting",
      name: "components",
      path: "src/components",
      kind: "folder",
      targets: [{ name: "components", path: "src/components", kind: "folder" }],
    },
  },
  {
    tool: "file_write",
    args: '{"path":"voidtask/tests/lib/store-crud.test.ts',
    activity: {
      label: "Writing store-crud.test.ts",
      verb: "Writing",
      name: "store-crud.test.ts",
      path: "voidtask/tests/lib/store-crud.test.ts",
      kind: "file",
      targets: [
        {
          name: "store-crud.test.ts",
          path: "voidtask/tests/lib/store-crud.test.ts",
          kind: "file",
        },
      ],
    },
  },
  {
    tool: "file_write",
    args:
      '{"content":"const fake = {\\"path\\": \\"fake.ts\\"};","path":"src/real-file.ts',
    activity: {
      label: "Writing real-file.ts",
      verb: "Writing",
      name: "real-file.ts",
      path: "src/real-file.ts",
      kind: "file",
      targets: [{ name: "real-file.ts", path: "src/real-file.ts", kind: "file" }],
    },
  },
  {
    tool: "file_edit",
    args:
      '{"target_paths":["tests/a.test.ts","tests/b.test.ts","tests/c.test.ts","tests/d.test.ts"],"edits":[',
    activity: {
      label: "Editing a.test.ts +3",
      verb: "Editing",
      name: "a.test.ts +3",
      path: "tests/a.test.ts",
      kind: "file",
      targets: [
        { name: "a.test.ts", path: "tests/a.test.ts", kind: "file" },
        { name: "b.test.ts", path: "tests/b.test.ts", kind: "file" },
        { name: "c.test.ts", path: "tests/c.test.ts", kind: "file" },
        { name: "d.test.ts", path: "tests/d.test.ts", kind: "file" },
      ],
    },
  },
  {
    tool: "shell_execute",
    args: '{"command":"pnpm test","cwd":"E:/work',
    activity: { label: "Running `pnpm test`" },
  },
  {
    tool: "grep",
    args: '{"pattern":"ToolCall","path":"src',
    activity: { label: 'Searching "ToolCall"' },
  },
  {
    tool: "auroro_websearch",
    args: '{"action":"fetch","url":"https://example.com","numResults":',
    activity: { label: "Fetching https://example.com" },
  },
  {
    tool: "shell_kill",
    args: '{"processId":"bg-42","pid":',
    activity: { label: "Stopping a process `bg-42`" },
  },
  {
    tool: "browser_navigate",
    args: '{"url":"http://localhost:1420","wait":',
    activity: { label: "Browsing to http://localhost:1420" },
  },
  {
    tool: "browser_click",
    args: '{"selector":"button.save","timeout":',
    activity: { label: 'Clicking element "button.save"' },
  },
  {
    tool: "browser_fill",
    args: '{"selector":"#email","value":"person@example.com',
    activity: { label: 'Typing into "#email"' },
  },
  {
    tool: "browser_scroll",
    args: '{"selector":"#pricing","amountPx":',
    activity: { label: 'Scrolling to "#pricing"' },
  },
  {
    tool: "browser_screenshot",
    args: '{"selector":"#app","format":',
    activity: { label: 'Capturing "#app"' },
  },
  {
    tool: "browser_get_console_logs",
    args: '{"level":"error","sinceMs":',
    activity: { label: "Reading console logs (error)" },
  },
  {
    tool: "browser_inspect_element",
    args: '{"selector":"#status","include":',
    activity: { label: 'Inspecting element "#status"' },
  },
];

describe("live tool activity", () => {
  it.each(cases)("reveals $tool details before the argument object finishes", ({
    tool,
    args,
    activity,
  }) => {
    expect(describeToolActivity(tool, args)).toEqual(activity);
  });
});

describe("spilled tool output never surfaces as a filename", () => {
  const SPILL =
    "C:\\Users\\a\\AppData\\Local\\AuroraIDE\\sessions\\6daeb9de.tool-results\\out-b6179211-content.txt";

  it("reads as tool output, not as a project file", () => {
    const activity = describeToolActivity(
      "file_read",
      JSON.stringify({ path: SPILL, start_line: 1, end_line: 100 }),
    );
    expect(activity.label).toBe("Reading tool output");
    // No file chip: there is nothing here the user can usefully open.
    expect(activity.path).toBeUndefined();
    expect(activity.targets).toBeUndefined();
  });

  it("applies to the batch form too", () => {
    expect(
      describeToolActivity("multi_file_read", JSON.stringify({ paths: [SPILL] })).label,
    ).toBe("Reading tool output");
  });

  it("leaves a real project file alone", () => {
    const activity = describeToolActivity(
      "file_read",
      JSON.stringify({ path: "components/ProfileForm.tsx" }),
    );
    expect(activity.label).toBe("Reading ProfileForm.tsx");
  });

  it("is not fooled by a project folder that merely contains the words", () => {
    // `.tool-results/` is the marker; a similarly named project dir is not.
    const activity = describeToolActivity(
      "file_read",
      JSON.stringify({ path: "src/tool-results-viewer/index.tsx" }),
    );
    expect(activity.label).toBe("Reading index.tsx");
  });
});
