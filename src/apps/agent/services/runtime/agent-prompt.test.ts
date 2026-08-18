import { describe, expect, it } from "vitest";

import { BASE_AGENT_SYSTEM_PROMPT } from "@/apps/agent/services/runtime/agent-prompt";

/**
 * The base prompt ships on EVERY request of every conversation, so anything
 * that drifts here is paid for thousands of times and believed by the model
 * until someone notices by hand. These pin the failures that actually happened.
 */
describe("the base system prompt does not contradict the tools", () => {
  it("never teaches a `paths` argument, which no tool declares any more", () => {
    // `file_read` used to declare `path` AND `paths`, and the prompt taught the
    // pair. The schema could not express "exactly one of" without `oneOf` (HTTP
    // 400 on strict validators), so the rule lived here in prose and was
    // enforced by REJECTION — and a strictly-decoding model, which fills every
    // declared property, sent both and was told its own correct call was
    // malformed. 6 of 60 `file_read` calls in one live thread died that way.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/`paths`/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/paths:\s*\[\]/);
  });

  it("describes `file_read` as one argument taking a string or an array", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`file_read` names what to read through ONE argument/);
  });

  it("does not state a browser tool COUNT, which drifted from 8 to 16 unnoticed", () => {
    // The removed section claimed "exactly eight browser tools" while the
    // roster held sixteen. A number in prose has no way to stay true; the
    // roster the model receives is the only honest source.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/exactly (eight|8|sixteen|16) browser tools/i);
  });

  it("keeps the browser doctrine out of the always-on prompt", () => {
    // ~1,126 tokens of it shipped on every request, including turns where
    // browser tools were switched off entirely. `browser_guidelines` carries it
    // now, and the pointer to that tool is gated on the same flag Rust reads.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/browser_page_outline/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/## Browser Tools/);
  });

  it("does not promise a separate IDE window to hand work to", () => {
    // The agent window is the product. Telling the model it can "reach into
    // the separate Aurora IDE window" offers a capability that is not there.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/separate Aurora IDE window/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/two brains/);
  });

  it("tells the model the harness itself can be at fault", () => {
    // Twice now a correct call was rejected by Aurora and the model concluded
    // it had erred — retrying variations until the turn died, once retracting
    // a correct bug report. This is the line that makes the other outcome
    // available to it.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/Aurora itself can be the thing that is broken/);
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/report_aurora_issue/);
  });

  it("explains the injected blocks and which of them go stale", () => {
    for (const marker of [
      "## Context Aurora Injects",
      "<repo_map>",
      "<aurora_task_reminder>",
      "<open_files>",
    ]) {
      expect(BASE_AGENT_SYSTEM_PROMPT).toContain(marker);
    }
    // The map is a snapshot and the reminder is live. Saying so is the whole
    // point — an agent that trusts the map after sixty edits is reading a
    // frozen picture as though it were the workspace.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`<repo_map>` is a SNAPSHOT/);
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`<aurora_task_reminder>` is LIVE/);
  });

  it("warns that compaction can erase earlier work from view", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/COMPACTED/);
  });

  it("states that open files carry names only, never content", () => {
    // The block is re-sent every turn. If it ever grows file bodies it becomes
    // the most expensive thing in the conversation.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/filenames only, never content/i);
  });
});
