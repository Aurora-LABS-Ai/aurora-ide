# Task Checklist

- [completed] Inspect Aurora and Zed workspace structure relevant to editor architecture and icon systems.
- [completed] Identify direct-port risks, especially license incompatibility and framework mismatch.
- [completed] Produce a concrete recommendation list of what Aurora should emulate, reimplement, or avoid from Zed.
- [completed] Create a fresh branch for the current Aurora work snapshot.
- [completed] Verify the current uncommitted workspace state before committing.
- [completed] Stage and commit all current changes.
- [completed] Introduce an Aurora explorer icon registry abstraction instead of direct material icon calls from UI components.
- [completed] Keep the current material icon theme as a first icon-pack adapter behind that registry.
- [completed] Re-run targeted validation for the new icon foundation files.
- [completed] Persist the active explorer icon pack in Aurora app settings so the icon ecosystem has a real settings-backed source of truth.
- [completed] Add the explorer icon-pack selector to both Appearance surfaces: the settings modal tab and the sidebar Appearance panel.
- [completed] Remove remaining direct material explorer icon calls in UI consumers and route them through the shared registry.
- [completed] Re-run focused frontend and Rust validation for the icon-pack integration pass.
- [completed] Define Aurora-native `.aurora` icon-pack bundle format and generic resolver instead of tying the ecosystem to VS Code packaging.
- [completed] Add custom icon-pack persistence/import state so user-installed Aurora icon packs survive restarts.
- [completed] Replace the temporary dropdown icon selector with card-based Appearance browsing that matches the existing theme-card/tab UI.
- [completed] Add a second shipped built-in explorer icon pack with transparent SVG assets and register it in the Aurora icon-pack system.
- [completed] Add a small Rust CLI pack builder to generate `.aurora` icon-pack bundles from a manifest plus assets.
- [completed] Document the `.aurora` icon-pack format and author workflow so users can create their own packs.
- [completed] Fix the Tauri dev startup break caused by multiple Rust binaries so `pnpm tauri:dev` runs the app again.
- [completed] Fold icon-pack building into the installed `aurora` CLI as `aurora icon-pack ...` instead of requiring a separate public binary.
- [completed] Update the icon-pack docs and helper scripts to use the main `aurora` CLI flow.
- [completed] Re-run focused frontend validation for the Aurora icon-pack ecosystem pass.

# Review

- Reviewed Zed's crate boundaries against Aurora's current Tauri + React architecture, with emphasis on icon systems, workspace boundaries, extensions, and editor-core strategy.
- Preparing a clean git snapshot of the current Aurora work before the next implementation pass.
- Created branch `codex/aurora-ecosystem-foundation`.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Verification: `pnpm exec eslint src scripts` failed with existing repo-wide lint issues outside this snapshot batch, including `src/App.tsx`, `src/components/chat/TaskView.tsx`, `src/components/editor/BrowserTab.tsx`, `src/components/modals/QuickOpenModal.tsx`, and others.
- Created commit `80e866e` with message `chore: snapshot current Aurora work`.
- Starting the first ecosystem-foundation step by separating explorer icon resolution from the current material-icon implementation.
- Added an Aurora explorer icon registry layer in `src/lib/icon-registry.ts` and `src/lib/icon-types.ts`.
- Moved the current material icon theme to an adapter role via `resolveMaterialExplorerIcon` in `src/lib/material-icon-theme.ts`.
- Updated `src/components/explorer/FileIcons.tsx` to resolve icons through the registry instead of calling the material theme directly.
- Verified with `pnpm exec eslint src/lib/icon-types.ts src/lib/icon-registry.ts src/lib/material-icon-theme.ts src/components/explorer/FileIcons.tsx` and `pnpm exec tsc --noEmit -p tsconfig.app.json`.
- Current pass is extending that foundation into a real settings-backed icon theme system shared by both Appearance UIs.
- Added `explorerIconPack` persistence through the frontend settings store, shared database types, and Rust app-settings repository/model path.
- Added a shared `ExplorerIconThemeSelector` and mounted it in `src/components/modals/ThemeSettingsTab.tsx` and `src/components/theme/ThemePanel.tsx` so the settings modal and sidebar Appearance surfaces now control the same icon theme state.
- Updated `src/components/explorer/FileIcons.tsx`, `src/components/agent/AgentChangesTree.tsx`, and `src/components/chat/ToolTimeline.tsx` to resolve file icons through the registry-backed pack setting instead of bypassing it with direct material icon calls.
- Verification: `pnpm exec eslint src/store/useSettingsStore.ts src/components/theme/ExplorerIconThemeSelector.tsx src/components/modals/ThemeSettingsTab.tsx src/components/theme/ThemePanel.tsx src/components/explorer/FileIcons.tsx src/components/agent/AgentChangesTree.tsx src/components/chat/ToolTimeline.tsx src/types/database.ts src/lib/icon-types.ts src/lib/icon-packs.ts` passed.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Verification: `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Next pass is shifting from “one configurable built-in icon pack” to an Aurora-native importable icon-pack format and builder workflow.
- Added Aurora-native icon-pack bundle parsing in `src/lib/aurora-icon-pack.ts` plus persistent custom-pack storage in `src/store/useIconPackStore.ts` and generic app-setting accessors in `src/services/database.ts`.
- Replaced the old dropdown selector with card-based icon-pack browsing in `src/components/theme/ExplorerIconPackPanel.tsx`, and mounted it as a dedicated Appearance sub-tab in both `src/components/modals/ThemeSettingsTab.tsx` and `src/components/theme/ThemePanel.tsx`.
- Fixed a real activation bug in `src/lib/icon-packs.ts` so imported custom packs can become the active explorer icon pack instead of being forced back to the built-in default.
- Verification: `pnpm exec eslint src/components/modals/ThemeSettingsTab.tsx src/components/theme/ThemePanel.tsx src/components/theme/ExplorerIconPackPanel.tsx src/lib/icon-packs.ts` passed.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Tightened the Appearance layout for narrow sidebars by making the tab rows wrap, stacking the icon-pack header actions safely, and switching the icon-pack card grid to auto-fit instead of forcing two columns.
- Verification: `pnpm exec eslint src/components/modals/ThemeSettingsTab.tsx src/components/theme/ThemePanel.tsx src/components/theme/ExplorerIconPackPanel.tsx` passed.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Removed the remaining edge-overlap behavior in `src/components/theme/ExplorerIconPackPanel.tsx` by restoring horizontal gutter padding and changing the card grid to `minmax(min(100%, 220px), 1fr)` so cards cannot bleed into the pane edges in collapsed sidebars.
- Verification: `pnpm exec eslint src/components/theme/ExplorerIconPackPanel.tsx src/components/modals/ThemeSettingsTab.tsx src/components/theme/ThemePanel.tsx` passed.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Added a second built-in explorer icon pack using transparent self-hosted VS Code icon SVGs, with local generation via `scripts/sync-material-icons.mjs` and pack resolution in `src/lib/vscode-icon-theme.ts`.
- Added a Rust `aurora-pack` builder CLI in `src-tauri/src/bin/aurora-pack.rs` plus a `pnpm icon-pack:build` wrapper in `scripts/build-icon-pack.mjs` so `.aurora` bundles can be built from source manifests and local assets.
- Added icon-pack author docs in `DOCS/05-ICON-PACKS.md` and a runnable starter pack example in `examples/icon-packs/starter/`.
- Tightened CLI validation so broken mappings fail at build time if they reference missing icon assets.
- Verification: `node scripts/sync-material-icons.mjs` passed.
- Verification: `pnpm exec eslint src/lib/vscode-icon-theme.ts src/lib/icon-packs.ts src/lib/aurora-icon-pack.ts scripts/sync-material-icons.mjs scripts/build-icon-pack.mjs src/components/theme/ExplorerIconPackPanel.tsx src/components/modals/ThemeSettingsTab.tsx src/components/theme/ThemePanel.tsx` passed.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Verification: `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Verification: `cargo build --manifest-path src-tauri/Cargo.toml --bin aurora-pack` passed.
- Verification: `build\\debug\\aurora-pack.exe build --manifest examples\\icon-packs\\starter\\manifest.json --output dist\\starter-pack.aurora --force` passed.
- Verification: `pnpm icon-pack:build -- --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack-script.aurora --force` passed.
- Verification: `pnpm icon-pack:build --manifest examples/icon-packs/starter/manifest.json --output dist/starter-pack-short.aurora --force` passed.
- New bug surfaced after adding the second Rust binary: `pnpm tauri:dev` now fails because `cargo run` cannot infer whether to launch `aurora` or `aurora-pack`.
- Current pass is fixing that dev regression and moving the builder onto the main installed `aurora` CLI so icon-pack authoring works through the same user-facing command users already install with Aurora.
- Removed the standalone `src-tauri/src/bin/aurora-pack.rs` binary and moved the builder into shared library code at `src-tauri/src/icon_pack.rs`, exposed through `aurora icon-pack build`.
- Updated `src-tauri/src/cli.rs` and `src-tauri/src/main.rs` so non-GUI icon-pack commands execute directly from the installed `aurora` CLI instead of launching the app window.
- Added `default-run = "aurora"` in `src-tauri/Cargo.toml` so Tauri/Cargo dev flows remain stable even if more helper binaries appear later.
- Updated `scripts/build-icon-pack.mjs` and `DOCS/05-ICON-PACKS.md` to use the main `aurora` CLI flow.
- Verification: `pnpm exec eslint scripts/build-icon-pack.mjs` passed.
- Verification: `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Verification: `cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --features cpu-only --color always -- --version` passed.
- Verification: `cargo run --manifest-path src-tauri/Cargo.toml --bin aurora -- icon-pack build --manifest examples/icon-packs/starter/manifest.json --output dist/cli-starter-pack.aurora --force` passed.
- Verification: `pnpm icon-pack:build -- --manifest examples/icon-packs/starter/manifest.json --output dist/pnpm-cli-starter-pack.aurora --force` passed.

## Active Task: Thread Context Rehydration Bug

- [completed] Trace the thread load path and verify whether the Rust context engine is rehydrated when reopening an existing thread.
- [completed] Inspect persisted thread message structure to confirm whether stored messages contain enough data to rebuild agent context.
- [completed] Implement a deterministic thread-to-context rehydration path so reopening a thread restores actual model memory, not just visible UI messages.
- [completed] Add targeted verification covering restored-thread context reconstruction and request building.
- [completed] Update the review section with root cause, fix summary, and validation results for the thread-memory bug.

# Review Addendum: Thread Context Rehydration Bug

- Root cause: existing-thread loading restored only the UI thread messages and saved usage stats, but the agent request path always built history from the Rust context engine. After app restart or thread switch, that Rust context remained empty because `context_init_from_thread` was never called.
- Added `src/services/context-rehydration.ts` to deterministically rebuild Rust `Turn` payloads from persisted thread messages, including assistant content, thinking blocks, and completed/failed/rejected tool executions from the stored timeline.
- Added `initFromThread()` to `src/store/useContextStore.ts` so the frontend can seed the Rust context engine from persisted thread history before the next request is sent.
- Updated `src/store/useThreadStore.ts` so thread selection and persisted-thread startup both rehydrate the Rust context engine, then restore saved context usage for the UI indicator.
- Added focused coverage in `src/services/context-rehydration.test.ts` and `src/store/useThreadStore.test.ts` for reconstruction and thread-load rehydration behavior.
- Verification: `pnpm exec vitest run src/services/context-rehydration.test.ts src/store/useThreadStore.test.ts` passed.
- Verification: `pnpm exec tsc --noEmit -p tsconfig.app.json` passed.
- Verification: `pnpm exec eslint src/services/context-rehydration.ts src/services/context-rehydration.test.ts src/store/useContextStore.ts src/store/useThreadStore.ts src/store/useThreadStore.test.ts` passed.

## Active Task: Zed-Inspired Appearance Parity

- [completed] Inspect Zed's theme and icon theme selectors to identify concrete customization behavior worth copying into Aurora.
- [in_progress] Bring Aurora's settings-modal Appearance surface to parity with the richer sidebar theme panel by adding safe live preview behavior and in-place editing.
- [pending] Re-run focused frontend validation for the touched customization files.
- [pending] Update the review section with the Zed references used, the Aurora changes made, and the verification results.
