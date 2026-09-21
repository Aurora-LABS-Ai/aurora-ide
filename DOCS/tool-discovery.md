# Tool discovery in Aurora

Implemented on `tools-reshape`, based on snapshot `ccec235e` on `main`.

Aurora keeps essential tools directly advertised and routes optional capabilities
through two fixed tool definitions. Finding a capability adds documentation to the
conversation without modifying the tool array or system prompt.

## Before and after

| Behavior | Previous implementation | Current implementation |
|---|---|---|
| Core files, search, shell, tasks, code, skills | Direct tools | Direct tools |
| Browser, MCP, team | Direct, or deferred behind an opt-in switch | Always discovered through `tool_search` |
| First successful search | Registered the entire optional catalog into the advertised registry | Returns matching descriptions and argument schemas as a text tool result |
| Optional invocation | Called the newly advertised tool directly | `call_tool` carries its name and arguments |
| Later requests | Different tool prefix after discovery | Same direct tools and the same two wrappers |
| Next user message / reopened task | Depended on process-local revealed names | Fresh catalog; no reveal state is needed |
| MCP connection changes | Changed tool schemas and the MCP system summary | Reflected in the next turn's catalog; wrapper definitions and system prompt stay unchanged |
| Execution and UI | Native or frontend bridge dispatch | Same executors, gates, and target-specific cards |

Availability is still mode-dependent. A hidden tool excluded by the browser,
vision, or execution-mode gates cannot be reached through `call_tool`. Existing
MCP approval and mode behavior remains the responsibility of the existing bridge.

## Example

Core work stays direct:

```text
file_read({"path":"src/App.tsx"})
grep({"pattern":"useSettingsStore"})
```

Optional work uses discovery:

```text
tool_search({"query":"select:browser_guidelines"})
  → the guide tool's description and argument schema

call_tool({"name":"browser_guidelines","arguments":{}})
  → the full guide; read it before interacting with the browser

tool_search({"query":"browser navigate"})
  → matching names, descriptions, and parameters

call_tool({
  "name":"browser_navigate",
  "arguments":{"url":"http://localhost:3000"}
})
  → the normal browser result
```

Every browser capability, including the guide, uses `call_tool`. Discovery returns
the schema, not the guide itself. Follow the returned schema for each tool's
arguments and use `{}` for tools with no arguments. A direct-call failure lists
only direct tools and supplies an exact discovery query; it does not prove the
optional capability is unavailable. Keyword search results may also be partial.

Search supports task keywords, `+required_name_fragment`, exact comma-separated
names, and `max_results` from 1 to 20 (default 5). Results report missing exact
names and whether more matches exist; narrow the query to retrieve more.

## Runtime ownership

- `commands/agent_v2/tool_policy.rs` filters availability, keeps native precedence,
  registers direct core tools, and collects optional executors.
- `tools/tool_search/` owns search, schema paging, invocation parsing, and argument
  validation. It installs both wrappers even when the catalog is empty.
- `agent_runtime/tool_executor.rs` resolves a single invocation envelope.
- `conversation/tool_dispatch.rs` prepares the effective operation. Execution
  batching, hooks, output caps, rich results, permissions, and bridge dispatch use
  the actual tool name and arguments.
- JSONL and provider history keep the original `call_tool` block and call ID.
  Result blocks answer that same ID. UI projection in `commands/threads.rs` and
  `services/tools/tool-invocation.ts` shows the underlying operation for both live
  and reopened tasks. Partial streamed envelopes display “Run Tool” until complete.
- Compaction recaps retain one example per underlying operation and preserve the
  callable envelope. If schema documentation leaves context, the model searches
  again; there is no global or per-thread reveal map to restore.

The catalog contains existing guarded executors. Native permission prompts still
name the underlying operation and receive its actual arguments. Timeout guards
stay inside permission guards, cancellation tokens and call IDs pass through,
and concurrency follows the target executor. Frontend-owned calls keep one
frontend lifecycle; invalid envelopes or arguments are rejected before dispatch.

## Argument schemas and large catalogs

`jsonschema` validates the registered parameter schema before execution, including
nested objects, required fields, arrays, enums, unions, and local references.
Compiled validators are created lazily and reused for the turn. HTTP and file
resolution features are disabled: external references produce an explicit error
instead of fetching resources. Invalid schemas and unknown targets fail before
the tool runs. Wrapper recursion and routing core tools through `call_tool` are
rejected.

Search bounds returned metadata to about 48 KiB, with separate envelope overhead.
A definition larger than 40 KiB returns `definition_page` chunks with offsets.
Continue with the returned exact query and `schema_offset: next_offset`, then
concatenate page text to recover the full JSON definition, including its complete
description. Unicode paging is lossless. The runtime's discovery cap is 96 KiB so
its generic 8 KiB JSON shrinker cannot discard required schema properties.

## Settings, migration, and cache limits

Optional discovery is the standard path. Settings → Agent → Tool loading explains
the behavior; its old toggle is removed. Legacy `deferTools` / `defer_tools` fields
remain readable for saved settings and older callers, but do not control loading.
The independent browser-access switch still removes browser capabilities.

Catalogs are snapshots taken at the beginning of a user turn. Newly connected MCP
tools become discoverable on the next user turn, including in an existing task.
Disconnecting a server mid-turn can still make an in-flight call fail through the
existing MCP connection check. This change does not add a live catalog update IPC.

The wrapper definitions contain no live tool-name list. Connected MCP metadata is
also removed from the composed system prompt. Tests compare serialized tool arrays
across discovery, empty/populated catalogs, changed schemas, reordered servers,
and rebuilt conversations, and compare full prompts across MCP summary changes.

This removes discovery-induced prefix mutation. Provider cache TTL, gateway
routing, model changes, changes to core tool definitions or mode, system rules,
and compaction can still affect cache reuse. No live billing reduction is claimed.
Provider-native tool-search formats and an external discovery MCP dependency are
not required by this implementation.

## Verification

Coverage includes stable schemas, nested validation, recursive and malformed
envelopes, schema paging, permissions granted/denied, cancellation, timeouts,
concurrent execution and ordered results, browser/vision/mode exclusions, a real
frontend bridge round trip with a test emitter, JSONL-shaped serialization,
reopened card projection, compaction recaps, live frontend event projection, and
system-prompt stability.

The frontend production build, frontend tests, and targeted ESLint checks run on
Windows. A browser check of the development frontend verifies the Tool loading
explanation, search result, and removal of the obsolete toggle at 1280×720 in the
dark theme. This browser check has no Tauri backend attached and does not verify
a live provider turn or native WebView interaction.

The full Rust suite has one failure in unchanged CLI color code:
`cli_delegate::term::tests::painted_text_carries_a_reset`. In this environment
Crossterm emits `ESC[m`, while the assertion accepts only `ESC[0m` or `ESC[39m`.
The same failure was reproduced in an isolated offline test crate using the
unchanged `term.rs` from snapshot `ccec235e` and Crossterm 0.29. All discovery/runtime
checks pass. See the final task report for exact counts.

Final verification on 2026-09-06: `pnpm build` passes; changed-file ESLint passes;
`cargo check --lib` passes; frontend suite **1,150 passed in 116 files**; Rust
suite **2,366 passed, 29 ignored, one confirmed baseline failure** described above.
Logs are local build artifacts: `build/tools-reshape-build.log`,
`build/tools-reshape-vitest-final.log`, `build/tools-reshape-rust-tests-final.log`,
and `build/tools-reshape-baseline.log`.
