# Aurora Semantic

This note captures the current Aurora semantic-search implementation and the local `aurora-semantic` crate analysis so the work can resume without re-reading the whole project.

## Repositories

- Aurora IDE: `E:\VOID-EDITOR\Aurora-Agent-IDE`
- Local semantic crate: `E:\VOID-EDITOR\aurora-semantic`
- Inspiration project for the next phase: `E:\VOID-EDITOR\GitNexus`

Aurora currently depends on `aurora-semantic = { version = "1.2.1", default-features = false }` from `src-tauri/Cargo.toml`. The local `E:\VOID-EDITOR\aurora-semantic` crate is also version `1.2.1`, but Aurora will not automatically use that local checkout unless the dependency is changed to a path dependency or patched in Cargo.

## High-Level Implementation

Aurora semantic search is embedded in the Tauri/Rust backend. It is not an external MCP server and it is not a separate sidecar process. The frontend settings UI and agent tool call into Tauri commands, and those commands use the `aurora-semantic` Rust crate as an in-process library.

The main Tauri command implementation is `src-tauri/src/commands/semantic.rs`. The commands are registered in `src-tauri/src/lib.rs` along with the rest of the Aurora backend commands.

The semantic engine is cached as a singleton:

- `ENGINE_CACHE: RwLock<Option<Arc<Engine>>>`
- `INDEXING_TASKS: RwLock<HashMap<String, bool>>`

The index storage directory is resolved from the user data directory as `aurora_agent/semantic`.

## Settings UI Index Flow

The settings entry point is `src/components/modals/SemanticSettingsTab.tsx`.

Important behavior:

- Loads semantic settings, all indexes, and the current workspace index when mounted.
- Lets the user set a model directory path.
- Provides an explicit save button for the model path rather than autosaving every keystroke.
- Supports enabling/disabling semantic search.
- Supports search mode selection: `hybrid`, `lexical`, or `semantic`.
- Provides debounced slider saves for semantic and lexical weights.
- Provides global ignored directories and file patterns.
- Provides workspace-specific excluded files and directories stored against the workspace index.
- The "Index Codebase" action calls `startIndexing(rootPath, workspaceName)`.

The Zustand store is `src/store/useSemanticStore.ts`.

Important behavior:

- `startIndexing` prevents duplicate starts when `isIndexing` is already true.
- It updates frontend indexing state, then calls `semanticService.startIndexing`.
- It has global event listeners for semantic index progress, completion, errors, and search results.
- `search` calls `semanticService.search`.

The IPC wrapper is `src/services/semantic.ts`.

Important commands/events:

- `get_semantic_settings`
- `save_semantic_settings`
- `get_semantic_indexes`
- `get_semantic_index`
- `start_semantic_indexing`
- `cancel_semantic_indexing`
- `semantic_search`
- `update_workspace_exclusions`
- `semantic-index-progress`
- `semantic-index-complete`
- `semantic-index-error`

## Rust/Tauri Indexing Flow

`start_semantic_indexing` in `src-tauri/src/commands/semantic.rs` is the main backend index entry point.

Flow:

1. Check `INDEXING_TASKS` to block concurrent indexing for the same workspace.
2. Load semantic settings from SQLite.
3. Create or update a row in `semantic_indexes`.
4. Spawn a Tokio task for the real indexing work.
5. `run_indexing` clears the engine cache to make sure settings/model changes are picked up.
6. `run_indexing` builds or retrieves an `Engine` via `get_or_create_engine(settings)`.
7. It emits an initial progress event.
8. It calls `engine.index_or_reindex_workspace`.
9. On success, it updates index metadata and emits `semantic-index-progress` plus `semantic-index-complete`.
10. On error, it stores the error status in the DB and emits `semantic-index-error`.
11. It clears the engine cache again after indexing, primarily to release model/GPU memory.

`get_or_create_engine(settings)` builds:

- `IgnoreConfig` from global ignored directories and patterns.
- `SearchConfig` from mode, semantic weight, lexical weight, and result limits.
- A workspace/storage config pointing at the semantic data directory.

Model loading behavior:

- If no valid model path is configured, Aurora falls back to `Engine::new(config)`, which uses hash embeddings.
- If the model path contains `jina-code-1.5b` or `jina-code-embeddings-1.5b`, Aurora uses `JinaCodeEmbedder`.
- Jina is configured with `EmbeddingTask::NL2Code`, `MatryoshkaDimension::D512`, and max length `8192`.
- Other model directories use `ModelConfig::from_directory(...).with_max_length(8192).load()`.

## Database Storage

Semantic DB persistence is implemented in `src-tauri/src/db/repositories/semantic.rs`.

Tables:

- `semantic_settings`: global settings such as enabled flag, model path, search mode, weights, ignored directories, and ignored patterns.
- `semantic_indexes`: per-workspace metadata such as workspace path/name, status, file/chunk counts, last indexed time, error text, excluded files, and excluded directories.

Index files are stored outside the Aurora SQLite DB in the app data semantic directory. SQLite tracks metadata and settings; the crate owns the binary/search index files.

## Agent Tool Flow

The agent-facing tool is `aurora_search`.

Definition:

- File: `src/tools/definitions/search-tools.ts`
- Description: semantic search across indexed codebase.
- Parameters include query, limit, mode, languages, chunk types, path patterns, symbol names, directories, excluded directories, and minimum score.

Registration/execution:

- Search tool definitions are exported through `src/tools/definitions/index.ts`.
- Search executors are exported through `src/tools/executors/index.ts`.
- The registry in `src/tools/registry.ts` binds tool definitions to executors.
- `AgentService.buildAvailableTools()` includes all enabled built-in tools plus MCP tools.
- The provider streams assistant responses and tool calls.
- `AgentToolRunner` executes the tool by name and returns the result to the agent loop.

`executeAuroraSearch` in `src/tools/executors/search-executors.ts` performs these checks:

1. Query must be non-empty.
2. A workspace root must be open.
3. Semantic search must be enabled in the frontend settings store.
4. The current workspace index must exist.
5. The current workspace index status must be `ready`.
6. Then it calls `semanticService.search`.

`semanticService.search` invokes the backend `semantic_search` command.

`semantic_search` backend flow:

1. Load semantic settings.
2. Load the workspace index record from SQLite.
3. Reject if the DB index is not `ready`.
4. Build or reuse the cached `Engine`.
5. Find the workspace inside the engine by root path.
6. Load the workspace into memory if needed.
7. Build a `SearchQuery`.
8. Apply optional filters.
9. Run `engine.search`.
10. Map crate results back to frontend `SemanticSearchResult` objects.

## aurora-semantic Crate Internals

The local crate API is centered on `Engine` in `E:\VOID-EDITOR\aurora-semantic\src\engine\mod.rs`.

Engine construction:

- `Engine::new(config)` creates an engine with `HashEmbedder`.
- `Engine::with_embedder(config, embedder)` accepts an ONNX/Jina embedder.

Indexing path:

- `index_workspace_with_id` initializes storage.
- It walks files with `FileWalker`.
- Each file is read and converted into a `Document`.
- The chunker produces semantic chunks.
- Embeddings are generated in batches.
- A Tantivy lexical index is built.
- A Usearch vector index is built.
- Documents, chunks, embeddings, vector index, mappings, and metadata are saved to disk.
- The workspace is inserted into the in-memory workspace map.

Reindexing path:

- `index_or_reindex_workspace` looks up an existing workspace by root path.
- If found, it deletes the existing workspace index and reuses the same workspace ID.
- If not found, it creates a fresh workspace ID.

Loading path:

- `load_workspace` loads metadata, documents, chunks, embeddings, Tantivy index, and Usearch vector index into memory.

Search path:

- `SearchQuery` and `SearchFilter` live in `src/search/query.rs`.
- Lexical search is implemented with Tantivy in `src/search/lexical.rs`.
- Semantic vector search is implemented with Usearch in `src/search/semantic.rs`.
- Hybrid search runs lexical and semantic search, then merges with configured weights.
- Lexical search supports fuzzy terms, symbol/path/language filters, and score normalization.
- Semantic search embeds the query, searches vectors, applies filters, uses cosine similarity, applies a short-chunk length penalty, and normalizes scores.

Chunking:

- The current chunker is regex/line-pattern based, not tree-sitter based.
- It has language-specific chunk extraction for Rust, Python, JavaScript, TypeScript, Go, and Java.
- It has fallback block chunking for unsupported languages.

On-disk crate storage:

- Per-workspace UUID directories.
- `metadata.json`
- `documents.bin`
- `chunks.bin`
- `embeddings.bin`
- `tantivy/`
- `vectors.usearch`
- `vectors.mapping.json`

## Important Gaps and Risks

Workspace-specific exclusions may not affect actual indexing. The UI stores workspace-specific excluded files/directories in `semantic_indexes`, but `get_or_create_engine(settings)` only uses global semantic settings when creating `IgnoreConfig`. No path was found that merges the current workspace index exclusions into the engine config before indexing.

`autoIndex` appears to be stored and exposed in settings, but no workspace-open or file-change caller was found that starts indexing automatically based on it.

The agent executor relies on the frontend Zustand `currentIndex` being fresh. If the DB/crate has a ready index but the store is stale or not loaded, the tool can report that the workspace is not indexed.

`cancel_semantic_indexing` removes the workspace from `INDEXING_TASKS` and marks the DB row as error/cancelled, but it does not cancel the already spawned Tokio indexing task. Real cancellation would require a cancellation token or cooperative cancellation in the crate indexing loop.

Indexing appears mostly sequential through `Engine::index_workspace_with_id`. The crate contains separate indexing modules such as `WorkspaceIndexer` and `ParallelIndexer`, but Aurora currently uses the main engine path.

The chunking approach is useful but shallow compared with a true code-intelligence index. It recognizes common symbol boundaries through patterns, but it does not build a durable AST/symbol/reference graph.

The backend `semantic_search` command does not enforce `settings.enabled`; the frontend executor does. A direct backend invocation could still search while disabled.

Changing embedding model or dimensions after an index exists can create stale index compatibility risks. Existing vector files were created with the old embedding dimensionality and may fail or produce bad results if loaded with a new embedder configuration.

The local semantic crate checkout is not automatically used by Aurora. Any Rust crate changes need a Cargo path dependency, patch override, or publish/update flow.

## Current Architectural Read

The best integration boundary for deeper improvements is likely the `aurora-semantic` crate, because it already owns indexing, search, storage, and the reusable engine API. Aurora IDE should keep its Tauri IPC and `aurora_search` tool surface mostly stable while the engine becomes smarter.

The high-leverage improvements are likely:

- Replace or augment pattern chunking with parser-backed code structure.
- Add symbol/reference/call graph storage.
- Make indexing incremental and cancelable.
- Persist richer metadata for files, symbols, definitions, references, and relationships.
- Improve ranking by combining lexical, vector, graph proximity, and symbol intent.
- Keep semantic embeddings as one retrieval layer rather than the whole code-intelligence model.

## GitNexus Analysis Target

Next analysis should inspect GitNexus as an inspiration source for a Rust port, not as an MCP dependency or sidecar project.

Primary areas to inspect:

- `ARCHITECTURE.md`
- `README.md`
- `GUARDRAILS.md`
- package layout and CLI entry points
- ingestion/indexing pipeline
- graph storage model
- query/context/impact tools
- type-resolution system and roadmap
- language providers
- scope and symbol resolution pipeline
- persistence format
- how GitNexus exposes context to an agent

The likely decision to make after that analysis: which GitNexus concepts should be ported into `aurora-semantic` as Rust modules, and which pieces belong in Aurora IDE integration code.

## GitNexus Architecture Findings

GitNexus is a TypeScript/Node monorepo. The core package lives in `E:\VOID-EDITOR\GitNexus\gitnexus`; the web UI in `gitnexus-web` is a thin graph/chat client. For Aurora, the important part is the core package, not the MCP packaging.

GitNexus describes itself as a graph-powered code intelligence system. The core difference from Aurora Semantic today is that GitNexus indexes code into a typed knowledge graph first, then optionally adds BM25 and embeddings on top. Aurora Semantic currently indexes documents/chunks/embeddings first and only has lightweight chunk metadata.

Important package dependencies:

- `tree-sitter` plus many language grammars.
- `@ladybugdb/core` for graph persistence and Cypher-like queries.
- `@huggingface/transformers` and `onnxruntime-node` for embeddings.
- `graphology` plus a vendored Leiden implementation for community detection.
- MCP SDK and Express for external serving. These are not part of the Rust port target.

## GitNexus End-to-End Flow

The CLI entry point `gitnexus analyze` calls `runFullAnalysis` in `gitnexus/src/core/run-analyze.ts`.

`runFullAnalysis` does:

1. Resolve local storage under `.gitnexus/`.
2. Load previous metadata and current Git commit.
3. Skip work if the index is already up to date.
4. Preserve existing embeddings unless explicitly dropped.
5. Run the ingestion pipeline with `runPipelineFromRepo`.
6. Rebuild LadybugDB from the produced graph.
7. Restore cached embeddings if compatible.
8. Optionally generate embeddings for new or changed nodes.
9. Save `meta.json`.
10. Register the repo in the global registry at `~/.gitnexus/registry.json`.
11. Update `.gitignore` with `.gitnexus`.
12. Generate agent context files such as `AGENTS.md` / `CLAUDE.md` as best effort.

Storage layout:

- Per-repo local storage: `<repo>/.gitnexus/`
- Graph DB file: `<repo>/.gitnexus/lbug`
- Metadata: `<repo>/.gitnexus/meta.json`
- Global registry: `~/.gitnexus/registry.json`

Aurora equivalent should not use a global registry. Aurora already knows the active workspace, so graph index metadata can remain per workspace in Aurora DB and `aurora-semantic` storage.

## GitNexus Pipeline DAG

The ingestion pipeline is in `gitnexus/src/core/ingestion/pipeline.ts`.

The phase list is static and dependency ordered:

```text
scan -> structure -> markdown/cobol -> parse -> routes/tools/orm
  -> crossFile -> scopeResolution -> mro -> communities -> processes
```

The runner is `pipeline-phases/runner.ts`.

Runner behavior worth porting:

- Static phase list, no plugin loading.
- Kahn topological sort validates missing dependencies and duplicates.
- Cycle errors include the concrete cycle path.
- Every phase receives only its declared dependency outputs.
- Every phase writes to a shared `KnowledgeGraph` accumulator.
- Phase errors are wrapped with the phase name.
- Progress/error events are emitted consistently.

This is a good model for Rust: a typed `IndexPhase` trait or enum-driven phase executor can keep indexing understandable while allowing later phases to depend on earlier outputs.

## GitNexus Graph Model

GitNexus builds an in-memory `KnowledgeGraph` during ingestion.

Core graph types are in `gitnexus-shared/src/graph/types.ts`:

- `GraphNode { id, label, properties }`
- `GraphRelationship { id, sourceId, targetId, type, confidence, reason, step?, evidence? }`

Main node labels:

- File/folder: `File`, `Folder`
- Symbols: `Function`, `Class`, `Interface`, `Method`, `Constructor`, `Property`
- Multi-language symbols: `Struct`, `Enum`, `Trait`, `Impl`, `TypeAlias`, `Const`, `Static`, `Variable`, `Macro`, `Namespace`, etc.
- Higher-level nodes: `Community`, `Process`, `Route`, `Tool`, `Section`

Main relationship types:

- Structure: `CONTAINS`, `DEFINES`
- Code flow: `CALLS`, `IMPORTS`, `USES`, `ACCESSES`
- Type hierarchy: `EXTENDS`, `IMPLEMENTS`, `INHERITS`, `METHOD_OVERRIDES`, `METHOD_IMPLEMENTS`
- Ownership: `HAS_METHOD`, `HAS_PROPERTY`
- Higher-level grouping: `MEMBER_OF`, `STEP_IN_PROCESS`
- Framework/API: `HANDLES_ROUTE`, `FETCHES`, `HANDLES_TOOL`, `QUERIES`, `WRAPS`

The in-memory implementation in `core/graph/graph.ts` keeps multiple indexes:

- `nodeMap`
- `relationshipMap`
- `relationshipsByType`
- `edgeIdsByNode`
- `nodeIdsByFile`

These indexes make removal and per-type traversal cheap. This is directly portable to Rust using `HashMap`, `HashSet`, and stable IDs.

## GitNexus Persistence

GitNexus persists the graph in LadybugDB.

Schema code is in `gitnexus/src/core/lbug/schema.ts`.

Persistence behavior:

- Separate node tables per label.
- One `CodeRelation` relationship table for all relationship types, with a `type` property.
- Separate `CodeEmbedding` node table for vectors.
- `loadGraphToLbug` streams nodes and relationships to CSV, then bulk loads them with `COPY`.
- Relationship CSV is split by source/target label pair because the DB requires typed relation endpoints.
- BM25/FTS indexes are created lazily on first query, not during analyze.
- Vector index is created for the embedding table when embeddings exist.

Rust port implication:

- We should not depend on LadybugDB unless there is a strong Rust binding and distribution story.
- For Aurora, SQLite is the pragmatic fit because Aurora already uses `rusqlite`.
- A Rust graph store can use tables like `semantic_graph_nodes`, `semantic_graph_edges`, `semantic_graph_embeddings`, plus indexes on `workspace_id`, `label`, `type`, `source_id`, `target_id`, `file_path`, and `name`.
- Keep Tantivy for lexical search and Usearch or another vector index for embeddings.
- The external tool behavior can match GitNexus without requiring Cypher as the public contract.

## GitNexus Parsing and Language Providers

GitNexus uses tree-sitter as the primary parser.

Parser loading:

- Main-thread loader: `core/tree-sitter/parser-loader.ts`
- Worker parser map: `core/ingestion/workers/parse-worker.ts`

Supported native parsers include TypeScript/JavaScript, Python, Java, C, C++, C#, Go, Rust, PHP, Ruby, plus optional Swift, Dart, and Kotlin.

The per-language strategy object is `LanguageProvider` in `core/ingestion/language-provider.ts`.

Provider responsibilities:

- File extensions.
- Tree-sitter query strings.
- Type extraction.
- Export detection.
- Import resolution.
- Named binding extraction.
- Import semantics.
- Call extraction.
- Field extraction.
- Method extraction.
- Variable extraction.
- Class extraction.
- Heritage extraction.
- MRO strategy.
- Built-in name filtering.
- Optional scope-resolution hooks.

Rust provider example: `core/ingestion/languages/rust.ts`.

Rust-specific choices in GitNexus:

- `.rs` extension.
- Named import semantics for `use`.
- `mroStrategy: 'qualified-syntax'`.
- Rust call extractor.
- Rust field/method/variable/class extractors.
- Rust heritage extractor.
- Built-in names are filtered from the call graph.

Aurora port implication:

- Replace Aurora Semantic's regex/line chunker with parser-backed extraction.
- Start with Rust, TypeScript/JavaScript, Python, Go, and Java if we need broad IDE value.
- Use a Rust `LanguageProvider` trait and keep per-language modules explicit.
- Continue producing chunks for embeddings, but make chunks derived from parsed symbols and graph nodes rather than raw regex blocks.

## GitNexus Parse Phase

The parse phase is implemented by `pipeline-phases/parse.ts` and `parse-impl.ts`.

Key behavior:

- Filters scanned files to parseable languages.
- Chunks work by byte budget, currently 20 MB per parse chunk.
- Uses a worker pool for larger repos.
- Falls back to sequential parsing.
- Reads file contents only for current chunk.
- Builds a tree-sitter AST cache.
- Extracts symbol nodes and basic relationships.
- Collects imports, calls, assignments, heritage, routes, tools, ORM queries, constructor bindings, and file-scope type bindings.
- Defers some resolution until all chunks have contributed enough graph data.
- Uses `BindingAccumulator` for cross-file type propagation.
- Clears native tree-sitter trees to manage memory.

Worker results are serializable:

- `nodes`
- `relationships`
- `symbols`
- `imports`
- `calls`
- `assignments`
- `heritage`
- `routes`
- `fetchCalls`
- `decoratorRoutes`
- `toolDefs`
- `ormQueries`
- `constructorBindings`
- `fileScopeBindings`
- `parsedFiles`

Sequential parsing writes nodes directly to the graph:

- Symbol nodes are generated from tree-sitter captures.
- IDs use stable generated IDs from label plus file/path/qualified name.
- `DEFINES` edges link `File` to symbol.
- `HAS_METHOD` or `HAS_PROPERTY` links owner types to members.
- `SymbolTable` is populated for later resolution.

Aurora port implication:

- We need a persistent Rust AST extraction layer, not only embedding chunks.
- Worker parallelism can be done with `rayon` or Tokio blocking tasks, but correctness should come first.
- Stable node IDs are important because future incremental indexing, context, and impact depend on consistent identity.

## Type Resolution and Semantic Model

GitNexus has two overlapping resolution systems:

1. Legacy call-resolution DAG.
2. New scope-resolution pipeline for migrated languages.

The type-resolution system is documented in `type-resolution-system.md`.

Important concepts:

- It is conservative, not a compiler.
- It maps variables to likely declared types so receiver-constrained calls can resolve.
- It runs per file, with cross-file seeding.
- It has a single AST walk and a fixpoint loop for assignments and method-call results.
- It tracks explicit annotations, loop element types, pattern bindings, copies, call results, field access, method-call results, and cross-file imports.

The authoritative symbol store is `SemanticModel` in `core/ingestion/model/semantic-model.ts`.

SemanticModel owns:

- Symbol table.
- Type registry.
- Method registry.
- Field registry.
- Optional scope-resolution indexes.

Important invariant:

- Symbol-indexed lookups must go through `SemanticModel`.
- Scope-resolution may carry a small `WorkspaceResolutionIndex` for scope-valued lookups only.
- After parse/reconciliation/finalize, downstream passes receive read-only model handles.

Aurora port implication:

- We should add a Rust `SemanticModel` layer inside `aurora-semantic`.
- Keep the model separate from the persisted graph store.
- The model should be mutable only during indexing, then frozen/read-only for search/context/impact.

## Scope-Resolution Pipeline

The newer pipeline is in `core/ingestion/scope-resolution/`.

Entry phase:

- `scope-resolution/pipeline/phase.ts`

Generic orchestrator:

- `scope-resolution/pipeline/run.ts`

Per-language resolver contract:

- `scope-resolution/contract/scope-resolver.ts`

Current migrated languages:

- Python
- C#
- TypeScript

Pipeline:

```text
ParsedFile[] -> finalizeScopeModel -> ScopeResolutionIndexes
  -> resolveReferenceSites -> ReferenceIndex
  -> emitReceiverBoundCalls
  -> emitFreeCallFallback
  -> emitReferencesViaLookup
  -> emitImportEdges
```

Important design decisions:

- `ParsedFile` is the AST-level truth.
- `SemanticModel` is the symbol-level truth.
- Scope-resolution emits the same graph node IDs and relationship vocabulary as the legacy path.
- Legacy and new paths can coexist per language.
- The emission order is load-bearing: receiver-bound calls run before fallback lookup.
- The pipeline has parity tests for migrated languages.

Aurora port implication:

- We do not need to port both legacy and scope-resolution paths.
- A Rust implementation should aim at the scope-resolution architecture directly.
- Migration can still be staged per language: parser extraction first, then import/call resolution, then type propagation.

## Cross-File Binding Propagation

The `crossFile` phase re-runs selected call resolution after imports and export maps are known.

Implementation:

- `pipeline-phases/cross-file.ts`
- `pipeline-phases/cross-file-impl.ts`

Key behavior:

- Runs after parse/routes/tools/orm.
- Processes files in topological import order.
- Seeds downstream files with upstream exported type bindings.
- Builds imported return-type maps.
- Skips work when too few files benefit.
- Caps reprocessed files at 2000.
- Uses an AST cache capped at 50.
- Disposes `BindingAccumulator` in a `finally` block.

Aurora port implication:

- Cross-file resolution must be a first-class indexing phase.
- Import graph topological order is a useful primitive.
- We should cap expensive re-resolution and expose progress.

## Communities and Processes

GitNexus adds higher-level graph abstractions after symbol resolution.

Communities:

- Implemented in `community-processor.ts`.
- Uses Graphology plus a vendored Leiden algorithm.
- Clusters symbol nodes by `CALLS`, `EXTENDS`, and `IMPLEMENTS`.
- Produces `Community` nodes.
- Produces `MEMBER_OF` relationships.
- Adds heuristic labels based on file/folder patterns.

Processes:

- Implemented in `process-processor.ts`.
- Finds entry points among functions/methods.
- Scores entry points by call ratio, exported/public status, names, and framework hints.
- Traces forward along high-confidence `CALLS` edges.
- Deduplicates traces.
- Produces `Process` nodes.
- Produces `STEP_IN_PROCESS` edges with step numbers.

Aurora port implication:

- These are not required for the first graph index, but they explain why GitNexus `query` returns execution flows instead of raw chunks.
- A practical Rust rollout should build symbols/imports/calls first, then add process detection after the graph is reliable.

## GitNexus Query Tool Behavior

The main query implementation is `LocalBackend.query` in `mcp/local/local-backend.ts`.

Tool behavior:

1. Run BM25 and semantic vector search concurrently.
2. Merge results with Reciprocal Rank Fusion.
3. For matched symbol nodes, find process membership via `STEP_IN_PROCESS`.
4. Fetch community membership and cohesion for ranking boost.
5. Optionally fetch source content.
6. Group by process.
7. Rank processes by aggregate match score plus a small cohesion boost.
8. Return:
   - `processes`
   - `process_symbols`
   - `definitions`
   - timing data

BM25:

- Implemented with LadybugDB FTS.
- Searches File, Function, Class, Method, and Interface.
- FTS indexes are created lazily.
- Results are merged per file using top matching node scores.

Semantic vector search:

- Uses the `CodeEmbedding` table.
- Embeds the query.
- Uses vector index search.
- Filters by distance.
- Maps embedding rows back to graph nodes.

Aurora port implication:

- `aurora_search` should eventually return graph-aware results, not only chunk hits.
- The useful target is a new result shape: processes/flows, symbols, definitions, and matched chunks.
- Existing raw semantic result compatibility can be kept for UI safety while adding graph fields.

## GitNexus Context Tool Behavior

`LocalBackend.context` provides a 360-degree symbol view.

Behavior:

1. Resolve symbol by UID or name.
2. If multiple candidates exist, return ranked disambiguation candidates.
3. Fetch incoming relationships.
4. Fetch outgoing relationships.
5. Expand class/interface incoming refs through constructors and owning files.
6. Fetch process participation.
7. Add method metadata where applicable.
8. Return symbol, incoming refs grouped by relationship type, outgoing refs grouped by relationship type, and process memberships.

Aurora port implication:

- Add a graph context command/tool separate from broad search.
- This is more useful for "explain this symbol before editing" than vector search.

## GitNexus Impact Tool Behavior

`LocalBackend.impact` performs blast-radius analysis.

Behavior:

1. Resolve target symbol by UID or name with disambiguation.
2. Traverse graph upstream or downstream with BFS.
3. Default relationship types include `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `METHOD_OVERRIDES`, and `METHOD_IMPLEMENTS`.
4. Optional relation filters include `HAS_METHOD`, `HAS_PROPERTY`, and `ACCESSES`.
5. Filter test files unless requested.
6. Respect minimum confidence.
7. Seed class/interface traversal through constructors and owning files.
8. Group affected symbols by depth.
9. Enrich with affected processes and modules.
10. Compute risk from direct count, process count, module count, and total impacted symbols.

Aurora port implication:

- This should become a separate Aurora agent tool, probably `aurora_impact`.
- It depends on graph correctness; do it after symbol/import/call graph is solid.

## Embeddings in GitNexus

Embeddings are optional and graph-node based.

Implementation:

- `core/embeddings/embedding-pipeline.ts`
- `core/embeddings/text-generator.ts`
- `core/embeddings/chunker.ts`
- `core/embeddings/structural-extractor.ts`

Behavior:

- Queries embeddable graph nodes.
- Generates enriched text from node metadata and content.
- Chunks long nodes.
- Embeds chunks in batches.
- Stores vectors in `CodeEmbedding`.
- Uses content hashes for incremental refresh.
- Preserves existing embeddings across reanalysis unless explicitly dropped.
- Discards cached embeddings if dimensions change.

Aurora port implication:

- Aurora already has embeddings; the improvement is to embed graph nodes/symbols, not arbitrary chunks only.
- Keep dimension compatibility checks and content hashes.
- Preserve existing embeddings across reindexing where possible.

## Recommended Rust Port Direction

Implement the GitNexus-inspired system inside `E:\VOID-EDITOR\aurora-semantic`, then expose it through Aurora IDE Tauri commands/tools.

Reasoning:

- `aurora-semantic` already owns indexing, search, storage, embeddings, lexical search, and reusable engine API.
- Keeping graph intelligence in the crate makes it reusable and testable outside Tauri.
- Aurora IDE should remain the UI/IPC/tool host, not the owner of parser/index internals.
- This avoids scattering graph logic across frontend Zustand, Tauri commands, and tool executors.

The first integration shape should be additive:

- Keep current `aurora_search` working.
- Add graph indexing behind the same "Index Codebase" flow.
- Extend search results with symbol/process metadata when available.
- Add dedicated graph tools later:
  - `aurora_context`
  - `aurora_impact`
  - possibly `aurora_graph_query` with a constrained query API, not raw Cypher at first.

## Suggested Rust Module Shape

Inside `aurora-semantic`:

```text
src/
  graph/
    mod.rs
    types.rs
    store.rs
    memory.rs
  pipeline/
    mod.rs
    runner.rs
    phases/
      scan.rs
      structure.rs
      parse.rs
      imports.rs
      calls.rs
      cross_file.rs
      communities.rs
      processes.rs
  languages/
    mod.rs
    provider.rs
    rust.rs
    typescript.rs
    python.rs
  parser/
    mod.rs
    tree_sitter.rs
  model/
    semantic_model.rs
    symbol_table.rs
    type_registry.rs
    method_registry.rs
    field_registry.rs
  tools/
    query.rs
    context.rs
    impact.rs
```

Likely Rust crates:

- `tree-sitter` and language grammar crates for parsing.
- `ignore` or existing file-walking logic for workspace walking.
- `rayon` for CPU-bound parse parallelism, or Tokio blocking tasks if integration needs async progress.
- `petgraph` for graph algorithms, or custom adjacency maps for direct control.
- `rusqlite` for persistent graph tables because Aurora already uses SQLite.
- Existing `tantivy` lexical search can remain.
- Existing `usearch` vector search can remain.
- `serde` plus `bincode`/existing storage format for fast graph snapshots if SQLite is not enough for hot reads.

## Suggested Rollout Plan

Phase 1: Graph Foundation

- Add graph node/edge types.
- Add stable ID generation.
- Persist graph nodes/edges per workspace.
- Add in-memory graph indexes.
- Keep current chunk/vector indexing intact.

Phase 2: Parser-Backed Symbol Extraction

- Add tree-sitter parser layer.
- Implement Rust provider first because the crate itself and Aurora backend are Rust-heavy.
- Extract File, Folder, Function, Struct, Enum, Trait, Impl, Method, Const, Static, Module.
- Emit `DEFINES`, `HAS_METHOD`, and basic `CONTAINS`.
- Derive embedding chunks from symbols.

Phase 3: Imports and Calls

- Resolve Rust imports initially.
- Extract call sites.
- Emit `IMPORTS` and `CALLS` with confidence/reason.
- Add symbol table and method registry.

Phase 4: Graph Query APIs

- Implement graph-backed `query`, `context`, and `impact` APIs in the crate.
- Expose Tauri commands.
- Add Aurora tools on top.

Phase 5: Type Resolution and Cross-File Propagation

- Add conservative TypeEnv.
- Add cross-file import topological pass.
- Add receiver-constrained call resolution.

Phase 6: Communities and Processes

- Add community detection.
- Add process tracing.
- Make `aurora_search` return execution-flow grouped results.

## Important Cautions

GitNexus is licensed under PolyForm Noncommercial. Before copying code or closely porting implementation text, confirm licensing constraints. The safest route is to use the architecture as inspiration and implement original Rust code.

Do not attempt to integrate GitNexus as an MCP server or sidecar. The user explicitly wants a Rust port/integration.

Do not put this first into Aurora frontend state. The frontend should only display status/results; the engine belongs in Rust.

Do not drop Aurora's current embeddings. The practical upgrade is graph plus embeddings, not graph instead of embeddings.

Do not expose raw arbitrary graph writes. GitNexus blocks write Cypher queries; Aurora should expose read-only graph APIs.

## Current Decision

Port the GitNexus approach into `aurora-semantic` first.

Aurora IDE integration should stay thin:

- Settings still trigger indexing.
- Tauri commands call engine methods.
- Agent tools call Tauri commands.
- New graph-aware tool results are introduced compatibly.

The core upgrade is a graph-first semantic engine:

```text
workspace files
  -> parser-backed symbol graph
  -> import/call/type resolution
  -> lexical/vector indexes over graph nodes
  -> graph-aware search/context/impact tools
```

This aligns with GitNexus's strongest idea while keeping Aurora's architecture clean and Rust-native.
