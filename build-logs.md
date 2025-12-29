                                                                                      47ms  12:18:54 
❯  pnpm tauri:build

> aurora@0.1.0 tauri:build E:\VOID-EDITOR\jules_aurora-agent-frontend
> tauri build

        Info Looking up installed tauri packages to check mismatched versions...
     Running beforeBuildCommand `pnpm build`

> aurora@0.1.0 build E:\VOID-EDITOR\jules_aurora-agent-frontend
> tsc -b && vite build

vite v7.3.0 building client environment for production...
✓ 2865 modules transformed.
[plugin vite:reporter] 
(!) E:/VOID-EDITOR/jules_aurora-agent-frontend/src/lib/tauri.ts is dynamically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useEditorStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/usePendingChangesStore.ts but also statically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/editor/CodeEditor.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/explorer/FileExplorer.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/explorer/TreeNode.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/terminal/Terminal.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useExplorerKeyboard.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useInternalDrag.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useRustChatSync.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useTauriDragDrop.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useWorkspaceBootstrap.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/services/context-builder.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useEditorStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/usePendingChangesStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useThreadStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useWorkspaceStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/editor-executors.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/shell-executors.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/workspace-executors.ts, dynamic import will not move module into another chunk.

[plugin vite:reporter]
(!) E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useEditorStore.ts is dynamically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/chat/ToolTimeline.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/usePendingChangesStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/usePendingChangesStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts but also statically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/App.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/chat/ChatInput.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/editor/CodeEditor.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/editor/EditorPanel.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/editor/TabBar.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/explorer/TreeNode.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/layout/StatusBar.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useAutoSave.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useExplorerKeyboard.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useInternalDrag.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/hooks/useTauriDragDrop.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/services/context-builder.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useWorkspaceStore.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/editor-executors.ts, dynamic import will not move module into another chunk.

[plugin vite:reporter]
(!) E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/usePendingChangesStore.ts is dynamically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors.ts but also statically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/editor/CodeEditor.tsx, dynamic import will not move module into another chunk.

[plugin vite:reporter]
(!) E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/utils/path-resolver.ts is dynamically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/chat/ToolTimeline.tsx but also statically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/editor-executors.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors-enhanced.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/file-executors.ts, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/workspace-executors.ts, dynamic import will not move module into another chunk.

[plugin vite:reporter]
(!) E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useTaskStore.ts is dynamically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/store/useChatStore.ts but also statically imported by E:/VOID-EDITOR/jules_aurora-agent-frontend/src/components/chat/ChatInput.tsx, E:/VOID-EDITOR/jules_aurora-agent-frontend/src/tools/executors/todo-executors.ts, dynamic import will not move module into another chunk.

dist/index.html                          0.46 kB │ gzip:   0.30 kB
dist/assets/index-DQ0NQGZD.css          48.21 kB │ gzip:   8.80 kB
dist/assets/index-SCTb5pOn.js            0.15 kB │ gzip:   0.15 kB
dist/assets/index-C4n8zqfp.js            1.26 kB │ gzip:   0.43 kB
dist/assets/webviewWindow-Cefvg8at.js    4.82 kB │ gzip:   1.43 kB
dist/assets/window-PK9364ZD.js          13.23 kB │ gzip:   3.30 kB
dist/assets/index-P9dUdaQZ.js          920.95 kB │ gzip: 280.42 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 7.76s
   Compiling aurora v0.1.0 (E:\VOID-EDITOR\jules_aurora-agent-frontend\src-tauri)
warning: unused imports: `AppSetting` and `Message`
  --> src\db\mod.rs:12:5
   |
12 |     AppSetting, LLMProvider, ToolSetting, AppSettings,
   |     ^^^^^^^^^^
13 |     ThreadState, Message,
   |                  ^^^^^^^
   |
   = note: `#[warn(unused_imports)]` (part of `#[warn(unused)]`) on by default

warning: unreachable pattern
   --> src\commands\mod.rs:438:17
    |
438 |                 _ => "other",
    |                 ^ no value can reach this
    |
note: multiple earlier patterns match some of the same values
   --> src\commands\mod.rs:438:17
    |
432 |                 EventKind::Create(_) => "create",
    |                 -------------------- matches some of the same values
433 |                 EventKind::Modify(_) => "modify",
    |                 -------------------- matches some of the same values
434 |                 EventKind::Remove(_) => "remove",
    |                 -------------------- matches some of the same values
435 |                 EventKind::Any => "any",
    |                 -------------- matches some of the same values
...
438 |                 _ => "other",
    |                 ^ ...and 2 other patterns collectively make this unreachable
    = note: `#[warn(unreachable_patterns)]` (part of `#[warn(unused)]`) on by default

warning: field `stream` is never read
  --> src\commands\llm.rs:11:9
   |
 6 | pub struct LlmRequest {
   |            ---------- field in this struct
...
11 |     pub stream: bool,
   |         ^^^^^^
   |
   = note: `LlmRequest` has a derived impl for the trait `Debug`, but this is intentionally ignored during dead code analysis
   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: method `connection` is never used
  --> src\db\mod.rs:64:12
   |
27 | impl Database {
   | ------------- method in this implementation
...
64 |     pub fn connection(&self) -> &rusqlite::Connection {
   |            ^^^^^^^^^^

warning: variants `NotFound` and `InvalidData` are never constructed
  --> src\db\error.rs:23:5
   |
 6 | pub enum DbError {
   |          ------- variants in this enum
...
23 |     NotFound(String),
   |     ^^^^^^^^
...
26 |     InvalidData(String),
   |     ^^^^^^^^^^^
   |
   = note: `DbError` has a derived impl for the trait `Debug`, but this is intentionally ignored during dead code analysis

warning: method `get_last_opened_at` is never used
  --> src\db\models.rs:19:12
   |
17 | impl WorkspaceState {
   | ------------------- method in this implementation
18 |     /// Convert the ISO timestamp string to OffsetDateTime
19 |     pub fn get_last_opened_at(&self) -> OffsetDateTime {
   |            ^^^^^^^^^^^^^^^^^^

warning: method `get_last_edited_at` is never used
  --> src\db\models.rs:58:12
   |
56 | impl EditorState {
   | ---------------- method in this implementation
57 |     /// Convert the ISO timestamp string to OffsetDateTime
58 |     pub fn get_last_edited_at(&self) -> OffsetDateTime {
   |            ^^^^^^^^^^^^^^^^^^

warning: methods `delete`, `delete_all`, and `get_all` are never used
  --> src\db\repositories\explorer.rs:64:12
   |
11 | impl<'a> ExplorerRepository<'a> {
   | ------------------------------- methods in this implementation
...
64 |     pub fn delete(&self, workspace_path: &str) -> DbResult<()> {
   |            ^^^^^^
...
74 |     pub fn delete_all(&self) -> DbResult<()> {
   |            ^^^^^^^^^^
...
80 |     pub fn get_all(&self) -> DbResult<Vec<ExplorerState>> {
   |            ^^^^^^^

warning: methods `delete` and `get_all` are never used
   --> src\db\repositories\workspace.rs:114:12
    |
 11 | impl<'a> WorkspaceRepository<'a> {
    | -------------------------------- methods in this implementation
...
114 |     pub fn delete(&self, workspace_path: &str) -> DbResult<()> {
    |            ^^^^^^
...
124 |     pub fn get_all(&self) -> DbResult<Vec<WorkspaceState>> {
    |            ^^^^^^^

warning: methods `delete`, `delete_all`, and `get_all` are never used
  --> src\db\repositories\editor.rs:81:12
   |
11 | impl<'a> EditorRepository<'a> {
   | ----------------------------- methods in this implementation
...
81 |     pub fn delete(&self, file_path: &str) -> DbResult<()> {
   |            ^^^^^^
...
91 |     pub fn delete_all(&self) -> DbResult<()> {
   |            ^^^^^^^^^^
...
97 |     pub fn get_all(&self) -> DbResult<Vec<EditorState>> {
   |            ^^^^^^^

warning: methods `delete_setting` and `get_tool_setting` are never used
   --> src\db\repositories\settings.rs:76:12
    |
 10 | impl<'a> SettingsRepository<'a> {
    | ------------------------------- methods in this implementation
...
 76 |     pub fn delete_setting(&self, key: &str) -> DbResult<()> {
    |            ^^^^^^^^^^^^^^
...
318 |     pub fn get_tool_setting(&self, tool_name: &str) -> DbResult<Option<ToolSetting>> {
    |            ^^^^^^^^^^^^^^^^

warning: method `connection` is never used
   --> src\db\repositories\threads.rs:142:12
    |
 12 | impl<'a> ThreadsRepository<'a> {
    | ------------------------------ method in this implementation
...
142 |     pub fn connection(&self) -> &Connection {
    |            ^^^^^^^^^^

warning: structure field `isThinking` should have a snake case name
   --> src\db\models.rs:129:9
    |
129 |     pub isThinking: Option<bool>,
    |         ^^^^^^^^^^ help: convert the identifier to snake case: `is_thinking`
    |
    = note: `#[warn(non_snake_case)]` (part of `#[warn(nonstandard_style)]`) on by default

warning: `aurora` (lib) generated 13 warnings (run `cargo fix --lib -p aurora` to apply 1 suggestion)
    Finished `release` profile [optimized] target(s) in 2m 09s
       Built application at: C:\Users\Alvan\.cargo\target\release\aurora.exe
        Info Patching binary "C:\\Users\\Alvan\\.cargo\\target\\release\\aurora.exe" for type msi
        Info Target: x64
 Downloading https://go.microsoft.com/fwlink/p/?LinkId=2124703
     Running candle for "C:\\Users\\Alvan\\.cargo\\target\\release\\wix\\x64\\main.wxs"
     Running light to produce C:\Users\Alvan\.cargo\target\release\bundle\msi\Aurora_0.1.0_x64_en-US.msi
        Info Patching binary "C:\\Users\\Alvan\\.cargo\\target\\release\\aurora.exe" for type nsis
        Info Target: x64
     Running makensis to produce C:\Users\Alvan\.cargo\target\release\bundle\nsis\Aurora_0.1.0_x64-setup.exe
    Finished 2 bundles at:
        C:\Users\Alvan\.cargo\target\release\bundle\msi\Aurora_0.1.0_x64_en-US.msi
        C:\Users\Alvan\.cargo\target\release\bundle\nsis\Aurora_0.1.0_x64-setup.exe

    Alvan  E:\VOID-EDITOR\jules_aurora-agent-frontend   main ≢  ?10 ~39 -1  -1   22.14.0              
                                                                                   2m 41.979s  12:21:48
❯