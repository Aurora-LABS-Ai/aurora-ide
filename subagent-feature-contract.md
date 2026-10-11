# Aurora subagent contract

Current contract, 2026-10-10. This replaces the initial reference-product contract where that document required model-facing synchronous spawning or polling that claimed reports. The accepted Aurora behavior is background spawning and one report delivery path.

## Delegation

The parent receives delegation tools only in Agent mode with subagents enabled. Plan and Chat must not receive them. A child must not receive delegation tools or start another child.

`spawn_agent` accepts:

```ts
type SpawnInput = {
  description: string
  prompt: string
  agentType?: string
  model?: string
  name?: string
  tools?: string[]
}
```

Every model-facing spawn is background work. It returns the child's stable ID immediately. Stopping the parent's current turn must not stop that background child. Explicit stop and application shutdown can cancel it. The internal synchronous host path must retain cancellation symmetry for callers that explicitly use it.

Resolve the definition, model and requested tools before creating storage or publishing running state. Unknown types, invalid grants and unavailable tools must fail with useful names and reasons.

## Isolation and permissions

A child must have its own conversation, system prompt, cancellation token, tool roster and transcript. It must not inherit the parent's conversation history. The task prompt must carry the scope, paths, constraints and acceptance criteria it needs.

The workspace filesystem is shared. File isolation and worktrees are not implemented by this contract.

Tool availability must be allowlisted. Each definition has default tools and a capability ceiling. A parent may select an exact subset through `tools`; it must not grant capabilities outside that ceiling or the currently supported parent/child execution pool. An empty array means no task tools.

Every hosted child receives `message_parent` and `submit_report`. Tool selection must not bypass approval rules, widen workspace access, permit user questions, or reintroduce recursion. Unsupported bridged tools must fail explicitly rather than being advertised and silently omitted.

The actual validated task-tool grant must be persisted and reused on resume. New defaults must not silently enlarge an existing agent's grant. Current user restrictions and capability revocation still apply. The child prompt must describe the actual installed tools.

## Messaging and continuation

`send_message` is the parent's single communication tool, with explicit `kind`: `message` for information or conversation, `reply` for answering a child question, and `task` for assigning or changing work. It resolves a parent-scoped name before an agent ID. Running children receive ordered messages at safe boundaries. Finished children answer ordinary messages or replies in a conversation-only turn with their saved history, no task tools, and no report reminder. Only task messages resume work and require a fresh report.

Message acceptance, the final queue drain and committing completion must be coordinated. An accepted message must either be read by the current run or trigger a continuation after it ends. No message may receive a successful queued acknowledgement and then remain unread because finishing raced it.

A new task instruction invalidates a report submitted for earlier work. Ordinary messages preserve it. An answer during work invalidates an already submitted report so it can cover the answer. Submitting while unread task instructions or answers remain queued must fail with guidance to process them first. Report-reminder state must reset when new work continues a run. Conversation-only exchanges preserve the previous task result, status, run count and end time.

A child's single `message_parent` tool supports `message`, `question` and `reply`. Every kind must reach the active parent queue or idle wake outbox. Questions wait by default, with optional `waitForReply: false` when the child can continue; a held question waits at most 120 seconds. Only explicit parent replies, plus legacy untyped replies, satisfy the waiter. Ordinary messages, new tasks and process events must remain separate from answers. A task update must release the wait immediately as a changed assignment, without consuming the task as an answer. A consumed answer must not be injected a second time. A finished child's brief conversation reply also reaches and wakes its parent, without becoming a work report.

## Completion and delivery

Children finish through `submit_report` with an outcome, actionable summary, full report and optional changed files. A run without a report receives one reminder. A second miss may use the last message, explicitly marked as not submitted.

Failure and stop must retain partial work and useful error context. A user stop must tell the parent not to restart that work without authorization.

Reports must travel through the parent conversation. `get_task_output` is a bounded activity view and must neither return nor claim a report. It must not compete with the completion delivery path.

An active parent receives the report at an ordinary tool boundary. A leftover at the end of the turn must move to the idle outbox. An idle wake must be recorded before its event is emitted and remain pending until the window acknowledges a send that carried it. Within a running window, delayed events, stale polls and failed acknowledgements must not send an already carried wake again.

The outbox is currently process-local. Recovery of undelivered wakes after a full restart is a future extension. Persistent transcripts retain the work.

Long report bodies must spill to a readable file with a useful inline summary and preview. A failed spill must preserve the report rather than delete it.

## Resume and model resolution

Resume must keep the ID, original task, transcript and previous answers. The existing runtime's tool-pairing repair must run before the replay reaches a provider.

Setup must finish successfully before a record is published as running. A failed sidecar write or validation must leave the agent terminal and must not consume a run number or strand later messages in a phantom runner.

A separately selected model must use its own API format, reasoning, extra fields, temperature, context window and output cap. Same-model inheritance must preserve the parent's already resolved settings.

Cursor protocol and variant handling are outside this implementation. Its bidirectional queued-message limitation remains documented, and Cursor is outside parent-delegation validation.

## Parent deletion

Deletion must block new work, cancel children and parent work, wait for finishing persistence and owned tracked processes, then remove storage and runtime caches. Manual compaction must participate in this lifecycle. A child or compactor must not recreate a deleted parent folder.

Work that does not stop within the deletion deadline must produce an explicit error before storage removal. Failure must restore admission for retry and must not falsely remove the frontend chat. Successful deletion must clear pending reports, child state and stale event/poll delivery for that parent.

## Acceptance checks

1. Background spawn returns immediately with one stable ID and a separate transcript.
2. Child rosters exclude recursion and unsupported bridge/UI tools.
3. Explicit and empty grants match the actual model schemas and prompt.
4. Invalid grants fail before child persistence or running-state publication.
5. Saved grants survive definition changes and resume from disk; revoked capabilities fail explicitly.
6. Parent messages arrive in order, including messages at the finishing transition.
7. Follow-up reports cover the latest instructions rather than retained earlier work.
8. Questions return the parent's answer once and leave process events queued separately.
9. Completion has one delivery path; checking activity never claims its report.
10. Delayed report events and stale polls do not repeat a carried wake.
11. Finished and evicted children resume under the same ID and preserve history.
12. Resume setup failure leaves a terminal record and unchanged run count.
13. Child model configuration matches per-model request semantics.
14. Explicit stop preserves partial work and the stop's owner.
15. Parent deletion stops owned work and prevents storage resurrection; timeout allows retry.
16. The existing permission gate still applies to an explicitly granted tool.
17. Production layout, ownership and unrelated work remain intact.

Implementation details and live-verification limits are in `DOCS/subagents.md` and `DOCS/subagents-implementation-phases.md`.
