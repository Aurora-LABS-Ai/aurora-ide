import { describe, expect, it } from "vitest";
import { reportBody, reportLead } from "./report-body";

const submitted = `<subagent_report agent="scout (agent_1)" type="explore" status="completed" outcome="partial">
Sub-agent "Find the login flow" completed after 1m 31s · 12 tool calls · 8421 tokens.
Outcome: partial
Summary: Login is in src/auth.ts:42; logout is not wired.
Changed files: src/auth.ts, src/session.ts

Report:
## Found
Summary: a heading the child wrote itself
- src/auth.ts:42

Transcript: C:/x/agents/agent_1/conversation.jsonl
To continue this agent with more work, call send_message with to="scout".
</subagent_report>`;

describe("reportBody", () => {
  it("shows an acknowledgement without presenting it as another work report", () => {
    const reply = `<subagent_message agent="worker (agent_1)" type="general-purpose" kind="reply">
Sub-agent "Fix the home page" replies to your message:

Thank you. No further work needed.

This is a conversation reply, not a new work report. No response is required unless it asks a question.
</subagent_message>`;
    expect(reportBody(reply)).toEqual({
      body: "Thank you. No further work needed.",
      meta: null,
      outcome: null,
    });
  });
  it("puts a submitted report's summary first and drops the labels", () => {
    const { body, meta, outcome } = reportBody(submitted);
    expect(outcome).toBe("partial");
    expect(meta).toBe("1m 31s · 12 tool calls · 8421 tokens");
    expect(reportLead(body)).toBe("Partial. Login is in src/auth.ts:42; logout is not wired.");
    expect(body).toContain("Changed files: src/auth.ts, src/session.ts");
    expect(body).toContain("## Found");
    // The child's own text keeps a line that merely looks like a label.
    expect(body).toContain("Summary: a heading the child wrote itself");
    for (const machinery of ["Outcome:", "Report:", "Transcript:", "To continue this agent"]) {
      expect(body).not.toContain(machinery);
    }
  });

  it("says nothing extra for a done report", () => {
    const done = submitted.replace(/partial/g, "done");
    expect(reportLead(reportBody(done).body)).toBe(
      "Login is in src/auth.ts:42; logout is not wired.",
    );
  });

  it("keeps the not-submitted warning and the last message", () => {
    const detail = `<subagent_report agent="scout (agent_1)" type="explore" status="completed" outcome="not_submitted">
Sub-agent "Job" completed after 12s · 3 tool calls · 900 tokens.
It did not submit a report with submit_report, even when asked. Its last message follows; check it before relying on it.

Last message:
Login is in src/auth.ts:42.

Transcript: p
To continue this agent with more work, call send_message with to="scout".
</subagent_report>`;
    const { body, outcome } = reportBody(detail);
    expect(outcome).toBe("not_submitted");
    expect(reportLead(body)).toContain("did not submit a report");
    expect(body).toContain("Login is in src/auth.ts:42.");
    expect(body).not.toContain("Last message:");
  });

  it("still reads a report written before submit_report existed", () => {
    const old = `<subagent_report agent="scout (agent_1)" type="explore" status="completed">
Sub-agent "Job" completed after 5s · 1 tool call · 100 tokens.

Report:
Login is in src/auth.ts:42.

Transcript: p
To continue this agent with more work, call send_message with to="scout".
</subagent_report>`;
    const { body, outcome } = reportBody(old);
    expect(outcome).toBeNull();
    expect(body).toBe("Login is in src/auth.ts:42.");
  });

  it("reads a mid-run message as before", () => {
    const message = `<subagent_message agent="scout (agent_1)" type="explore" status="running">
Sub-agent "Job" is still working and says:

I have no shell tool.

It cannot ask the user. Answer it with send_message to="scout"; it keeps working meanwhile and will still send its report when it finishes.
</subagent_message>`;
    const { body, meta, outcome } = reportBody(message);
    expect(body).toBe("I have no shell tool.");
    expect(meta).toBeNull();
    expect(outcome).toBeNull();
  });
});
