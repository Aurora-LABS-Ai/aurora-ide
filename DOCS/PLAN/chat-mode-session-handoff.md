# Aurora Chat — session handoff (2026-09-04)

**Read this first next session.** It is the exact state of the chat-mode
image work at the moment the session ended, what is verified, what is not,
and where to pick up. Companion docs: `DOCS/PLAN/chat-mode-design.md`
(decisions), `DOCS/PLAN/implementation-progress.md` (phase tracker — NOT yet
updated for this session; see "Next session" below).

Nothing is committed. Everything below is in the working tree (`git status`
shows ~55 modified + ~16 new files under `src/` and `src-tauri/`).

---

## Verified state at end of session

| Check | Result |
|---|---|
| `cargo check --lib` (src-tauri) | clean, 0 errors, 0 warnings |
| `npx tsc -p tsconfig.app.json --noEmit` | clean |
| `npx eslint` on every touched TS/TSX file | clean |
| vitest: `timeline.test.ts` (65), `image-providers.test.ts`, `thread-model.test.ts`, `useAgentCommandStore.test.ts`, `useSettingsStore.providerDescription.test.ts` | all pass (107 tests in the run) |
| **Full** `pnpm test` | **NOT run this session** |
| `cargo test` | **NOT run this session** (only `--lib` check) |
| Live run of Path A end to end (real image provider) | **NOT done** |

---

## What was built this session, in order

### 1. Rust `ContentBlock::Image` (Path A groundwork) — done

A first-class block for a picture that IS the assistant's reply.

- `src-tauri/src/agent_runtime/types.rs` — `ContentBlock::Image { asset, path, media_type, width, height, prompt?, model?, artifact? }` + `ContentBlock::image_as_text()` (one-line text a model reads instead of the picture).
- Every `match` on `ContentBlock` got an `Image` arm. Models always get the **text line**, never an image part in an assistant message (Anthropic rejects those):
  - `src-tauri/src/commands/team.rs`
  - `src-tauri/src/agent_runtime/conversation/tokens.rs` (token estimate)
  - `src-tauri/src/api/commandcode/adapter.rs`
  - `src-tauri/src/api/provider_kernel_adapter.rs` (`message_blocks_to_anthropic_content`, `collect_text`)
  - `src-tauri/src/api/responses.rs`
  - `src-tauri/src/chat_memory/index.rs` (`message_text`)
  - `src-tauri/src/commands/threads.rs` — the reload path emits a timeline event `{ kind: "image", id, asset, path, mediaType, width, height, prompt, model, artifactId, status: "ready" }` from `session_to_db_messages_rich`; `content` gets the text line (copy text). API/export views also use the text line.

### 2. Rust direct-generation command (Path A) — done, compiles, untested live

- **New** `src-tauri/src/commands/image_direct.rs` — `image_direct_generate(request: ImageDirectRequest) -> ImageDirectResult`.
  One call = whole turn: `ensure_thread` → `load_or_create_session_in(Chat)` → append user message + set `session.model` → `ImageClient::generate` → `materialize` → `assets::store` → `place_in_canvas` (image artifact) → append assistant message with a single `ContentBlock::Image` → `save_to_path` → `set_workspace_and_model` (pin) → title from prompt via `agent_runtime::title::derive_thread_title` when still `"New Chat"` → `touch` → chat-memory index.
  Errors are `String`s in the provider's own words (empty prompt, >4000 chars, size not offered by the model, etc.).
- Registered: `src-tauri/src/commands/mod.rs` (`pub mod image_direct;`) and `src-tauri/src/lib.rs` `generate_handler!` (right after `image_provider_discover_models`).
- `src-tauri/src/tools/image/mod.rs` — `place_in_canvas` extracted to a free `pub(crate) fn place_in_canvas(store, thread_id, assets_dir, record, title) -> Result<String, String>`; the tool's method now delegates to it. Shared by tool path and direct path.

### 3. Frontend Path A — done, typechecks, not run live

- `src/apps/agent/services/providers/image-providers.ts` — new helpers: `IMAGE_PROVIDER_ID_PREFIX = "img-"`, `isImageModelSelection`, `imageModelFromSelection(selection, providers)`, `imageModelSelection(model)`, `aspectRatioOfSize(size)`. Image provider ids are always `img-…` (`useSettingsStore.addImageProvider`), so a pin `img-xxx:modelKey` is recognisable without a lookup.
- `src/apps/agent/lib/thread/thread-model.ts` — `applyChatShortlist` returns image selections untouched (the shortlist is ticked on the language-provider page and can never contain one; it used to silently swap the chat back to a language model).
- `src/apps/agent/services/providers/image-direct.ts` — **new** IPC wrapper `generateImageDirect()` → `image_direct_generate`.
- `src/apps/agent/hooks/conversation/direct-image-turn.ts` — **new** `runDirectImageTurn()`: `beginTurn` → optimistic user bubble → assistant seed whose timeline is one `{kind:"image", status:"pending", width, height}` event (shape from `model.defaultSize ?? sizes[0]`, square fallback) → `setThreadActivity("Making the picture…")` → IPC → `settleImageEvent` to `ready` (or `failed` with the error) → `refreshThreads` → `endTurn` → `noteTurnComplete` → `useAgentArtifactStore.absorbRuntimeWrite(threadId)`.
- `src/apps/agent/hooks/conversation/useAgentWindowSend.ts` — in `sendTurn`, right after `projectRoot` is computed and BEFORE `store.beginTurn`: `imageModelFromSelection(modelSelection, settings.imageProviders)` → if hit, `await runDirectImageTurn(...)` and `return`. Staged `/` chips are consumed above and NOT forwarded.
- `src/apps/agent/components/conversation/timeline.ts` — `TimelineEvent` gains `DirectImageEvent` (`kind: "image"`, `status: "pending" | "ready" | "failed"`, dims, prompt/model, asset/path/mediaType/artifactId, error); `TimelineRow` gains `{ type: "image"; image }`; `buildRows` emits it; new `settleImageEvent(tl, id, patch)`.
- `src/apps/agent/components/conversation/DirectImage.tsx` — **new**. Card 01 (frameless). `SilkPlaceholder` stays mounted under the `<img>` until `onLoad`, then unmounts; `data-ready` flips the img opacity (0.6s crossfade). Failure keeps the same aspect box and says why. "Open in Canvas" pill bottom-right on hover. Preview modal on click.
- `src/apps/agent/components/conversation/MessageBubble.tsx` — `renderRow` handles `row.type === "image"` → `<DirectImage>`.
- `src/apps/agent/theme/agent-window/44-direct-image.css` — **new**; imported last in `src/apps/agent/theme/agent-window.css`.
- `src/apps/agent/components/composer/ModelSelector.tsx` — `RichOption.image?: boolean`; in **chat surface only**, `options` appends every model of every `imageProviderReady` image provider (each provider its own group; label = `m.label || modelKey`; `image: true`). Row shows the `image` glyph with tooltip "Makes pictures. Replies with an image; reads no history." `RowFast`/`RowReasoning` already return null for these rows.
- `src/apps/agent/components/composer/AgentComposer.tsx` — placeholder becomes "Describe the picture — only this message is sent" when the composer's model is an image selection (chat surface).

### 4. `/image` slash command (Path B) — done earlier this session

`IMAGE_COMMAND` in `src/apps/agent/adapters/prompt-commands.ts`; `imageRequested` on `CommandSelection` (`useAgentCommandStore.ts`); `buildImageRequest()` → `<image_request>` block in `useAgentWindowSend.ts` (fresh turn and mid-turn steering); offered only when `chatSurface && imageProviders.some(imageProviderReady)` (`AgentComposer.tsx`); `image` kind added to `AttachedCommandChip`/`AttachedPromptChip` (`thread-service.ts`) and `COMMAND_CHIP_ICON` (`MessageBubble.tsx`). Tests: `src/apps/agent/store/composer/useAgentCommandStore.test.ts`.

### 5. Provider description (user request mid-session) — done, tested, not seen in the running app

Small optional one-line description per **language** provider, shown inline under the title in the provider card head, pencil to edit, capped at 150 characters, persisted in SQLite.

- **DB v25**: `src-tauri/src/db/schema.rs` — `SCHEMA_VERSION = 25`, `llm_providers.description TEXT` in `create_llm_providers_table`. `src-tauri/src/db/migrations.rs` — arm `25 =>` + `migration_v25` (PRAGMA-sniffed `ALTER TABLE llm_providers ADD COLUMN description TEXT`).
- `src-tauri/src/db/models.rs` — `LLMProvider.description: Option<String>` (`#[serde(default)]`).
- `src-tauri/src/db/repositories/settings.rs` — both SELECTs read it as column 21 (`row.get(21)`), the upsert writes it as `?22` (insert list, `ON CONFLICT` set, params).
- `src/kernel/types/database.ts` — `DbLLMProvider.description: string | null`.
- `src/kernel/store/useSettingsStore.ts` — `LLMProvider.description?: string`; `PROVIDER_DESCRIPTION_MAX = 150`; `normalizeProviderDescription()` (collapse whitespace, trim, cap by code points, `undefined` when empty). Applied in `dbToProvider`, `providerToDb`, the preset-merge in `loadFromDatabase`, `updateProvider`, `addCustomProvider`.
- `src/apps/agent/settings/ProviderDescription.tsx` — **new** component: read state (text + pencil that appears on hover/focus), empty state ("Add a description" ghost button with pencil), edit state (input `maxLength=150`, live `n/150` counter that turns `--agw-warning` at the cap; Enter saves, Esc cancels, blur saves).
- `src/apps/agent/settings/ProvidersSettings.tsx` — rendered inside `.agw-prov-detail-titles` under `.agw-prov-detail-sub` in the **generic** head only (Atlas/Codex/Cursor/OpenCode/CommandCode/Kenari/Modal own their heads and were not touched).
- `src/apps/agent/theme/agent-window/22-settings-providers-detail.css` — `.agw-prov-desc*` rules after `.agw-prov-detail-sub`.
- Tests: `src/kernel/store/useSettingsStore.providerDescription.test.ts`.

### 6. Earlier in this session (before the summary), already done

Registry `store_for_thread` fix; `tools/image/` (wire/client/assets/config/mod — `generate_image` tool, `BUILTIN_TOOL_COUNT = 44`); `AgentChatRequest.image_providers`; `commands/image_providers.rs` (test + discover); frontend image artifact kind + `CanvasImage.tsx` + tool card render; settings Test / Discover / `AddProviderChooser`; `ImageProviderProbe.tsx`. See `implementation-progress.md` Phase 5 and `.knowledge/knowledge.md` (entries dated 2026-09-04).

---

## Known gaps / things to double-check first next session

1. **Path A has never been run live.** First thing: `pnpm tauri:dev`, add an image provider (Settings → Providers → Add → Image provider), tick nothing on the shortlist or tick some (both cases), open the composer's model picker in Aurora Chat, pick the image model, send a prompt. Watch: silk placeholder appears at the model's default aspect → picture crossfades in → "Open in Canvas" opens the artifact → reopen the chat and the picture renders from the reload path (`kind: "image"` event). Check the rail title is derived from the prompt.
2. **Reload-path field parity.** Rust emits `artifactId`/`mediaType` camelCase in `threads.rs`; `DirectImageEvent` expects the same names. Verified by reading, not by running.
3. **`aurora_image` size cap** — `image_direct.rs` uses `assets::MAX_ASSET_BYTES` for `materialize`; confirm that constant is the intended limit for direct pictures (it is what the tool uses).
4. **`ensureThreadForSend`** in `useAgentChatStore` (line ~830) creates the draft thread before the direct branch via `threadService.createThread(deriveThreadTitle(firstUserText), null, "chat", deepResearchNext)`; `image_direct_generate` calls `ensure_thread` again (idempotent by design, but confirm no duplicate rail rows). Because the frontend already titles the thread from the first message, Rust's `"New Chat"` title fallback in `image_direct.rs` will rarely fire — both derive from the prompt, so there is no conflict, only redundancy.
5. **Model pin persistence when the chat is brand-new**: `runDirectImageTurn` relies on Rust's `set_workspace_and_model(thread_id, None, Some(model_selection))`. Confirm the composer shows the image model after reopening.
6. **Image models and `useSettingsStore.selectedModel`**: picking an image model in the selector also sets the app-wide default (`setSelectedModel`). In **Build** the selector never offers image models, but a default pointing at `img-…` would make a new Build chat fall through `resolveModelRequest` and show "model no longer available". Decide: either don't write `selectedModel` for image picks, or resolve Build's default past image pins. **Not handled yet.**
7. **`/image` + image model at once**: if the pinned model is an image model, staged `/image` is simply consumed and ignored (harmless). Fine, but undocumented in the UI.
8. **Provider description in the rail list** (`.agw-prov-*` cards on the left): NOT shown there, only in the head. User asked for the head; leave unless asked.
9. `cargo test` and the full `pnpm test` were not run — the `commands/agent_v2/tests.rs` and `command_thread_safety.rs` suites in particular should be run (new async command added).

---

## Next session — start here

1. Read this file, then `.knowledge/knowledge.md` tail and `.knowledge/lesson.md` tail.
2. Run `cargo check --lib` and `npx tsc -p tsconfig.app.json --noEmit` to confirm the tree still compiles.
3. Run the live check in "Known gaps" #1. Fix whatever breaks.
4. Decide and implement gap #6 (image pin vs `selectedModel` default in Build).
5. Remaining todo items from the session's list:
   - **Attach a conversation asset from the composer** (pending, not started) — design in `chat-mode-design.md` "Editing" section: the conversation's `assets/` is a pool; composer should be able to stage an existing asset (for `generate_image` edit).
   - **Update `implementation-progress.md`** Phase 5 rows for: Path A (done, pending live verify), `/image` (done), provider description (new, not in the plan — add a line).
   - Append to `.knowledge/knowledge.md`: what shipped (this doc's §1–§5), and to `.knowledge/lesson.md` if anything breaks during the live check.
   - Full `pnpm test` + `cargo test` green.
6. Constants to keep in sync in `CLAUDE.md`/`AGENTS.md` when you get there: `SCHEMA_VERSION = 25`, `BUILTIN_TOOL_COUNT = 44`, `generate_handler!` count +3 (`image_provider_test`, `image_provider_discover_models`, `image_direct_generate`).

---

## Session todo list as it stood

- [x] 1 AgentRegistry::store_for_thread; artifacts commands route by thread
- [x] 2 Rust tools/image (wire, assets, generate_image, register 44)
- [x] 3 AgentChatRequest.image_providers + turn driver hands config to tool
- [x] 4 commands/image_providers.rs test + discover, registered
- [x] 5 Frontend: send imageProviders; image artifact kind; tool card + Canvas render
- [x] 6 Settings: Test, Discover models, Add-provider kind chooser
- [x] 7 /image slash command → instruction in message context
- [x] 8 Path A: image model as conversation model, card 01 on SilkPlaceholder, title/compaction fallback — **code complete, live verification pending**
- [x] (unplanned) Provider description: DB v25 + inline editor under provider title, 150-char cap
- [ ] 9 Attach a conversation asset from the composer
- [ ] 10 Update implementation-progress.md + knowledge.md; full test suites green
