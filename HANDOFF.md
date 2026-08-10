# Handoff — 2026-08-08

Everything below is **uncommitted** in the working tree. Rust: 1086 tests green.
Frontend: 440 tests, `tsc` clean, eslint clean on every touched file.
**Not runtime-verified — no `pnpm tauri:dev` this session.**

---

## Start here (next session, in this order)

1. **qg-probe dump the agent window** on a long transcript. I designed against
   screenshots and got the palette wrong twice; don't repeat that.
2. **Find where tool-call coalescing stops.** Aurora already renders
   `Read File [a][b][c][d] · Read 4 files` when a model batches reads into one
   assistant message. A model that reads one file per iteration (Agnes 2.5 Flash)
   gets 13 separate rows instead. Coalescing works *within* an assistant message,
   not *across consecutive iterations*.
3. **Decide grouping only after that.** If consecutive same-tool calls coalesce
   across iterations, the "13 rows of Read File" problem disappears using the
   component that already exists — no system prompt, no heuristic, no new visual
   concept. The user may not want grouping at all afterwards.

Open sub-problem: interleaved `Thought` rows split a run of reads. They'd need to
fold into the coalesced row (a small `thought 0.4s` affordance) rather than
breaking it. That's the only real design work in the coalescing fix.

---

## Shipped this session

### 1. Context accounting — was wrong in both directions

`/compact` reported 431k → 272k on a chat the provider measured at 180k.

- **Reasoning signatures counted as prompt text.** `Thinking.signature` holds a
  Responses-API `encrypted_content` blob — 22.7% of one real transcript — and is
  replayed only by Responses/Codex. Every other provider strips reasoning.
  `ReasoningReplay` (`api/client.rs`: `Dropped` / `Text` / `Opaque`, from provider
  type) now prices it by what the provider actually replays. A signature is never
  counted as text; under `Opaque` it's `len / ENCRYPTED_REASONING_CHARS_PER_TOKEN`.
- **Tool schemas were missing** from the compaction projection — an under-count of
  the opposite sign. `fixed_request_overhead_tokens()` + `projected_request_tokens()`
  are now the single definition, shared by the auto trigger and `/compact`.
- **Measured on the real JSONL:** 267,725 → 133,923 messages-only, which plus
  system + schemas reconstructs the provider's 180,235.

### 2. Context size is measured, not re-derived

After reviewing `E:\VOID-EDITOR\openclaude` (`src/utils/tokens.ts`
→ `tokenCountWithEstimation`). `projected_request_tokens` now **anchors on the last
request the provider measured** and estimates only messages appended since. Error
can't accumulate across a conversation. From-scratch survives only as the fallback
(fresh session / no-usage provider / anchor dropped by compaction). Aurora's own
synthetic usage is never an anchor.

`measured_context_tokens` = input + **cache_creation** + cache_read + **output**.
Both additions were real bugs — cache-write is most of the prompt on a
cache-writing turn, and the completion is re-sent as input next request.
`ContextRing` sums the same four.

### 3. Compaction

- **Circuit breaker** — `MAX_CONSECUTIVE_COMPACTION_FAILURES = 3`,
  `COMPACTION_FAILURE_COOLDOWN_MS = 5min`, state on `Session` (process-local).
  A failed compaction doesn't fix the overrun that called it, so it re-qualified
  and re-paid every turn. `CompactionOutcome` separates `SummaryFailed` (counts)
  from `NothingToDo` (free). Manual `/compact` bypasses the breaker.
- **Handoff-note prompt** — second person, `<analysis>` scratchpad (stripped by
  `format_compact_summary`) then `<summary>` under 10 headings. Sections 6 (every
  user message verbatim) and 10 (next step with quoted text) were absent before.
  `compaction_preamble` carries behaviour: *pick up where you left off, the user
  saw no interruption*. `transcript_hint` names the JSONL path when
  `allow_outside_workspace` is on, so compaction is lossy but recoverable.
- **Summary budget** 8192 → **16000** (range 4000–24000) — it now covers the
  drafting pass AND the note.
- **Cache sharing** — the summarization request used to change system prompt,
  tools and thinking config, diverging the prefix at token zero and re-billing the
  whole history at fresh rates on the *same model*. `summarize_with(share_cache)`
  now mirrors the conversation's own request when no compaction model is pinned
  (system prompt, full tool catalogue, thinking config, reasoning left in place),
  with the instruction in the trailing user message led by
  `COMPACTION_NO_TOOLS_PREAMBLE`. Empty result retries once in the standalone shape.
- **Compaction model** — Settings → Agent. `compactionModel` →
  `getCompactionConfig()` → `compactionProviderConfig` → `with_compaction_client`.
  Marker records the summarizer's model so cost is priced at its rates.
  **Guidance: default (unset) is usually cheapest** — a pinned model pays fresh
  input for the whole head, so it only wins if its rate beats the chat model's
  *cache* rate (~1/10 of list).

### 4. "The provider returned an empty reply"

Reported 5× in one day. Proof from the JSONL: assistant messages with `blocks: []`
and `output_tokens` of 1 and 4 — the provider produced content and billed for it;
Aurora dropped it.

`anthropic.rs` `content_block_start` matched only `text`/`thinking`/`tool_use` with
`_ => None`. **`redacted_thinking`** fell through, and because no block was inserted
every later delta at that index bailed too. Fixes: `redacted_thinking` mapped and
round-tripped via `encode_redacted_thinking` (must go back as
`{"type":"redacted_thinking","data":…}`); unknown block types now `eprintln!` the
type name; a blockless assistant message is no longer appended to the session
(it serializes to Anthropic as empty content → rejected) and the turn re-issues
**once**.

### 5. Anthropic wire schema — was written for pre-4.7 Claude

`build_anthropic_body` emitted `{"type":"enabled","budget_tokens":N}` and always
inserted `temperature`. **Both are hard 400s on Claude 4.7+** (Opus 4.7/4.8/5,
Sonnet 5, Fable 5). Every request to a current Claude was malformed.

`anthropic_surface_for(model)` picks the shape per model: adaptive +
`output_config.effort` on 4.6+, legacy budget otherwise. Also handles:
`thinking.display` defaults to `"omitted"` on 4.7+ (blocks stream with empty text —
Aurora renders them, so `"summarized"` is now requested); omitting `thinking` means
different things per generation (Opus 5 / Sonnet 5 / Fable 5 reason by default,
4.8/4.7 don't); `{"type":"disabled"}` is rejected by Fable 5 at any effort and by
Opus 5 above `high` effort; `xhigh` doesn't exist below 4.7 so effort is clamped.

**Unknown models deliberately get the LEGACY shape** — a provider typed "anthropic"
is usually a gateway, and `budget_tokens` is what those implement.

⚠️ **This table is hardcoded and the user objects to that** — see Open below.

### 6. models.dev reasoning capability

`normalizeReasoning` collapsed `reasoning_options` (an **array** — a model declares
every control it has) down to one, so the settings form hardcoded all four choices.
Now keeps `supported: ["effort","budget","toggle"]` and **derives** `toggleable`
from whether a toggle exists. `ProvidersSettings` renders reasoning-type choices
from `supported`; rows without it (pre-field) still show everything, and the
selected type is never filtered out mid-edit.

---

## Open

1. **Replace the hardcoded `anthropic_surface_for` table with catalog data.**
   The user pointed at OpenRouter's `/api/v1/models` → `supported_parameters`,
   which is the real per-model request contract (`reasoning_effort`, `reasoning`,
   `temperature`, `top_p`, …). Plan: `openrouter-catalog.ts` alongside
   `models-dev.ts` (same 24h-cache/stale-fallback shape) → derive
   `ModelReasoning.supported` + an `allowsSampling` flag → feed through to Rust so
   the model list goes away. **Caveat:** `supported_parameters` describes what
   *OpenRouter's* layer accepts, so use it for **capability**, not field naming —
   Aurora's per-API-type adapter still owns `output_config.effort` vs
   `reasoning_effort` vs `reasoning.effort`. Catalog says *what*, adapter says
   *how to spell it*.
2. **Composer: reasoning off should hide the effort selector.** Currently the
   depth control still renders when reasoning is switched off.
3. **Levels field is unvalidated free text.** The user's Opus 5 row has
   `low, medium, high` (Opus 4.5's ladder) so xhigh/max are unreachable. Rust
   clamps so nothing 400s, but the UI never corrects it. Existing rows keep the
   stale value — the import fix only applies to newly added models.
4. **Grouping / transcript density** — see "Start here". Three probes were built
   and all rejected; the coalescing insight came after and supersedes them.

---

## Lessons (all now in `.knowledge/lesson.md`)

- **Probe first for any non-trivial UI change** — self-contained HTML, numbered
  live variants, a recommendation, saved to `C:\Users\Alvan\Documents\`. This is
  lesson 2026-07-22 and I broke it again this session.
- **Copy real `--agw-*` tokens** from `theme/themes.ts` (agentDark), the way
  `aurora-transcript-variant-designs.html` does. I invented a green accent from
  screenshots; Aurora's is `--agw-accent: #3994bc` on `#161616`. Two probes were
  deleted for this.
- **Load `surface-philosophy` before any user-facing work** (CLAUDE.md, mandatory).
  Skipped it and shipped a wire-protocol spec dump into the provider settings
  panel; removed.
- **Don't design a rule that needs the model to narrate.** Two grouping proposals
  were bounded on assistant text; the user's real run had *one* spoken line in
  twelve steps.
- **A `_ => None` arm in a wire decoder is silent data loss.** Providers add block
  types; say what you didn't understand.
- **Anything persisted but only conditionally sent must be priced by the provider
  view, not its on-disk size.** Persisted ≠ sent.
- **Don't re-derive what the provider already measured** — anchor, then estimate
  the delta.
