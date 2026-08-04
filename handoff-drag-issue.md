# Handoff — OS file drop (Windows Explorer → agent composer). **FIXED, runtime-verified 2026-08-04.**

Root cause: on Windows the OS drag lands on the WEBVIEW, so Tauri emits
`tauri://drag-*` from `manager/webview.rs::on_webview_event` → `emit_to_webview`
(tauri 2.9.5, `manager/webview.rs:705`), whose delivery filter is:

```rust
EventTarget::Webview { label } | EventTarget::WebviewWindow { label } => label == window_label,
_ => false,
```

Only `Webview`- and `WebviewWindow`-kind listeners are ever fed. That kills both
prior attempts:
- `getCurrentWindow().onDragDropEvent(...)` registers `{kind:'Window'}` → `_ => false`.
- `listen(name, h, { target: label })` (string ⇒ `{kind:'AnyLabel'}`) → `_ => false`.
- `{kind:'Any'}` bypasses the filter (`event/listener.rs::match_any_or_filter`),
  which is why the diagnostic listener always saw the events.

The handoff's earlier analysis read the WINDOW emit path
(`manager/window.rs:194`, which emits `EventTarget::labeled` = AnyLabel and would
have matched); that path isn't the one used for a webview window on Windows.

Fix (`src/agent-window/hooks/useAgentExternalDrop.ts`): subscribe with
`{ kind: 'WebviewWindow', label: getCurrentWindow().label }`. Everything else
(position fallback, widened drop zone, physical→CSS px conversion at 150% DPI)
was already correct.

Proof: with all four target kinds registered simultaneously in the live window,
an Explorer drop fired ONLY `WebviewWindow` + `Any`; `Window` and `AnyLabel`
stayed silent. After the one-line target change, owner confirmed the pill
appears on a real Explorer drag. Temporary `[agw-drop]` console log removed.

Reference that agrees: `svelte-tauri-filedrop` uses
`getCurrentWebview().onDragDropEvent(...)` (Webview kind — the other kind the
filter feeds).
