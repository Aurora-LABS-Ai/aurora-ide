# Desktop Control — design, decided but not built

**Status: agreed, unimplemented.** Nothing in this document exists in the codebase yet.
It records a design conversation (2026-08-11) in full so it never has to happen twice.

Aurora builds desktop apps. It cannot currently look at one. This is the plan for giving the
agent eyes and hands on a running Windows application — specifically **the app you are building** —
by porting the `qg-probe` daemon out of QuantumHub.

Source of the port: `E:\QuantumHUB-Infrustructure\agent-studio\qg-probe`
Source of the guideline text: `C:\Users\Alvan\Documents\alvan-quantumgram-claw\skills\os-control\SKILL.md`

---

## 1. What qg-probe actually is (verified, not summarised from its README)

One self-contained C# executable — `net9.0-windows`, WPF + raw `IUIAutomation` COM,
**62.8 MB** published today (single-file, self-contained, no .NET runtime needed on the target).

It runs as a long-lived **JSON-lines daemon** on stdin/stdout under `--serve`:

```
→ {"ready":true,"ready_ms":11,"pid":…,"engine":"dotnet-uia3"}
← {"id":1,"cmd":"set_target","args":{"processName":"Telegram"}}
→ {…result…, "rid":1, "exec_ms":3}
```

Ready in ~11 ms, warm call overhead ~0–2 ms. `shutdown` ends it. `once` runs a single command
without the control gate (kept for hand-debugging).

**31 commands** in `Controller.Dispatch`: `ping`, `list_windows`, `screen_context`, `set_target`,
`dump_tree`, `dump_foreground`, `app_search`, `open_app`, `focus_window`, `launch_app`, `resolve`,
`click`, `click_xy`, `type_into`, `grab`, `send_keys`, `key`, `scroll`, `scroll_to`, `move_window`,
`close_window`, `drag`, `wait`, `find_text`, `capture`, `clipboard_read`, `clipboard_write`,
`take_control`, `release_control`, `control_status`, `halo`.

**The control gate.** Under `--serve` every perception and input command is refused with
`needs_control` until `take_control` opens a session and puts the halo on screen.
`release_control` ends it; the person can end it themselves with `Ctrl+Alt+Shift+Q`, which is
recorded as `user_revoked` (sticky until the next `take_control`).

Windows only. `net9.0-windows` + WPF + IUIAutomation COM — the macOS equivalent is a rewrite,
not a port.

---

## 2. The decisions

### 2.1 Native Rust tools, not an MCP server

qg-probe does not speak MCP. Wrapping it would mean writing an adapter to get *less*, and Aurora's
rule is that the Rust registry is the only source of the model's native tools. It ships as an
`externalBin` beside `rg.exe`, with source under `src-tauri/probes/qg-probe/` next to `code-index`.

### 2.2 Port the perception engine. Do not rewrite it in Rust.

`windows-rs` exposes `IUIAutomation` and `BuildUpdatedCache` fully, so a Rust rewrite is possible.
It is still the wrong call: `UiaDump` / `UiaInvoke` / `UiaScroll` / `UiaBringIntoView` plus
`WinInput` / `WinEnum` / `ClipboardNative` are several thousand lines of behaviour that is invisible
until it breaks — prune rules, node numbering, flipping Chromium accessibility on from cold,
virtualised rows, `AttachThreadInput` + phantom-Alt focus, clipboard retry. Rewriting means
re-finding bugs that are already fixed.

The JSON-lines contract is the seam. If the .NET dependency ever becomes intolerable, the engine can
be replaced behind it without touching Aurora's tools, prompt, or guideline.

### 2.3 Drop WPF — the halo becomes an Aurora window

WPF is in that exe for two reasons, and Aurora wants neither:

- **QuantumFinder** (`AppIndex.cs`, `AppIcons.cs`, `FinderWindow.cs`) — a Spotlight-style launcher.
  Aurora has its own command centre, and we are dropping app launching entirely (§2.4).
- **The halo** (`Halo*.cs`) — the consent overlay. Aurora should draw this itself: it already
  creates native WebView windows for the browser tools, the Rust side owns the control session
  (§2.5), and a Rust global hotkey handles `Ctrl+Alt+Shift+Q`. An Aurora-drawn halo also uses
  Aurora's own tokens instead of QuantumHub's.

With `UseWPF=false` the two odd csproj settings go with it: `InvariantGlobalization=false` existed
only for WPF text input, `ApplicationManifest` only for DWM Mica/Acrylic.

**Consequence:** the exe drops from ~62 MB to an estimated 15–20 MB, so the installer goes from
112 MB to roughly 130 MB rather than 165 MB.

> **Verify before promising this:** whether anything in the dump path leans on `app.manifest` for
> DPI awareness. `screen_context` and `move_window` both do DPI-aware rectangle maths.

### 2.4 No app launching

`app_search` / `open_app` / `launch_app` are dropped. Aurora's job is building apps, not launching
arbitrary ones — the agent already starts the app under test with `shell_execute` running
`pnpm dev`. `focus_window` folds into `see(target)`, because pinning a window you are about to
drive should raise it; you cannot reliably click an occluded one.

### 2.5 The setting is the consent — no per-action approval

When desktop control is enabled in Settings → Agent, it just works. No approval prompt per action,
none for taking control. The halo and `Ctrl+Alt+Shift+Q` are the live signal and the kill switch.

This makes the control session **automatic**: Rust calls `take_control` on the first computer
command of a turn and `release_control` at turn end, on disable, on app exit, and on daemon crash.
That deletes a whole failure class — the agent cannot forget to take control, cannot forget to
release, and cannot leave the halo stuck on. `take_control`, `release_control`, `control_status`
and `halo` never reach the model.

### 2.6 Vision-gated, hard

**Without a vision model this toolset is pointless.** The UIA tree reports that a button named
"Save" exists at node 18. It cannot report that the padding is wrong, the chart failed to render,
the label overflows, or the dark theme is unreadable — which is the entire reason to look at an app
you just built.

`LLMModel.supportsVision` already exists per model in `useSettingsStore` and is resolved for the
active model. Two hard gates: **the setting is on AND the active model can see images.** Fail
either and the tools are not registered — the model never learns they exist.

The settings row must say **which** gate is closed. A toggle reading ON while nothing works is the
same lie as a green checkmark on a failed tool. When it is off because of the model, the prompt
block must say the model cannot see, not tell the user to enable a setting that is already on.

---

## 3. The tool surface — 3 tools

31 daemon commands collapse to three, each with a typed `op`. Same reasoning that took the file
toolset 16→10: the model picks the tool by intent and the op by specific.

| Tool | Ops | Wraps |
|---|---|---|
| `computer_see` | `windows` · `screen` · `target` · `tree` · `foreground` · `find` · `screenshot` | list_windows, screen_context, set_target (+focus), dump_tree, dump_foreground, find_text, capture |
| `computer_do` | `click` · `type` · `keys` · `scroll` · `scroll_to` · `drag` · `move` · `close` · `wait` | click, click_xy, type_into, send_keys, key, scroll, scroll_to, drag, move_window, close_window, wait |
| `computer_clipboard` | `read` · `write` | clipboard_read, clipboard_write |

Never exposed to the model: `take_control`, `release_control`, `control_status`, `halo` (Rust drives
them), `ping` (health check), and `grab` / `resolve` — Rust attaches each node's stable `el_…` id to
every `see` result and accepts it in `do`, so the model gets stale-index recovery without a tool it
has to remember to use.

`move` covers minimise/maximise/restore via `move_window`'s `state` argument.

**`close` must refuse to close Aurora's own window.** qg-probe already guards its host app; the port
must guard ours. Ending the session mid-task is unrecoverable.

---

## 4. Screenshot is primary perception, not a last resort

The QuantumHub skill says *"Screenshots are NOT perception."* That is right for its job — driving
Telegram, you do not care how it looks. **For Aurora it is backwards.** The loop is:

```
see(screenshot)    judge the work
see(tree)          act precisely, read exact text
do(click, n:18)
see(screenshot)    did the fix land
```

This also disposes of OCR. `os_ocr` is not in the daemon at all (QuantumHub's lives on the
TypeScript side), and with vision it is unnecessary: a Qt or canvas app that UIA cannot read is
simply a picture the model looks at. No escalation ladder.

**Screenshot quality becomes load-bearing.** Reuse the browser screenshot pipeline
(`aurora_image`, downscale, in-card image) but verify its behaviour rather than assume it: capture
per-window rather than full-screen, and cap the long edge rather than applying a blind ratio. A 4K
window scaled too far turns small text into mush the model will confidently misread.

---

## 5. The guideline — compiled in, beside `design/`

Delivered exactly like `design_guidelines`: doctrine text compiled into the binary as a const in
`src-tauri/src/tools/os_control/guide.rs`, returned by a `computer_guidelines` tool. Not a skill —
it never appears in `aurora_skill_search`. Unlike `design_guidelines` it is registered **only when
both gates in §2.6 are open**.

**It must be rewritten against our surface, not copied.** The source SKILL.md documents ~20 `os_*`
tools including `os_ocr`, `os_run_workflow`, `os_open_app`, `os_find_app`, `os_launch_app`,
`os_app_search`, `os_minimize_window`, `os_maximize_window`, `os_restore_window`, `os_click_at` —
several deliberately dropped, one that does not exist in the daemon. Copying it would describe tools
that are not there, which is the same class of failure as a green checkmark on a failed tool.

What to carry across, rewritten for `see` / `do` / `clipboard`:

- **Reading the outline** — `[n]` resets on every dump, indentation means containment, `act:` and
  `state=`, lines without `[n]` are structural context only
- **Reading does not raise the window.** A perfect-looking tree from a window buried behind three
  others, reporting real coordinates that belong to someone else's pixels. The subtlest trap in the
  document
- **`type` pastes via the clipboard; `keys` focuses nothing.** Chromium/Electron/Qt search boxes
  drop synthetic keystrokes mid-stream but accept a real paste — and the apps under test will be
  Electron and Tauri
- **Titles lie** — confirm an app is running by process, never by window title
- **Never Alt+F4.** It goes to whatever holds focus, not the target. It has closed the host app
  mid-task. Use `do(close)`, which targets by name
- **`modifiers` and `anchor` on click** — a grid row's centre is usually a button, so a plain click
  hits the wrong thing. `anchor:"left"` selects the row
- **Prefer the app's own search box** over reading a long list
- **`screen` for layout work** — monitors, work areas, DPI, visible rectangles, z-order. The visible
  rect already accounts for the invisible ~7px resize border, so the numbers you read are the
  numbers you set
- **Closed-to-tray and refused-close** must be reported accurately, never rounded up to "done"

Plus the two divergences from §2.4 and §4: no launching (start it with `shell_execute`), and
screenshot-first perception.

---

## 6. System prompt blocks

Follow the existing `CHAPTER_INSTRUCTIONS` pattern in
`src/apps/agent/services/runtime/agent-prompt.ts` — a constant appended on a flag.

**Enabled** — working rules, not a feature announcement:

> You can see and drive desktop applications on this machine. This is for the app you are building:
> start it yourself, then look at it. Flow is `see(screenshot)` to judge, `see(tree)` to act.
> Trees are large and go stale after any action — re-read rather than acting on an old one, and use
> `see(find)` to locate something without dumping again. You already have control; the user can see
> the halo and take it back at any time.

**Disabled** — two lines, and the second half is the important one:

> Desktop inspection exists but is switched off. If a task would genuinely be answered by looking at
> the running app, say so once and point at Settings → Agent. Then continue without it and do not
> raise it again in this conversation.

That last sentence is load-bearing. `.knowledge/lesson.md` records that the model drops advisory
caveats; here the risk is the opposite — nagging. Once, then never again.

---

## 7. Context discipline — the thing that sinks it if we get it wrong

qg-probe's own README is explicit: a 1500-node dump is ~150 KB of XML, roughly **38k tokens**, and
the Python tester blew a 262k window in a handful of action turns. The dotnet harness fixed it with:

- **history pruning** — only the newest two tool results keep their full tree; older trees are
  stubbed, because their `n` indices are stale after every re-dump and the model can never act on
  them anyway
- **per-tree cap** — a single tree truncated at 60k chars with a marker pointing at `find_text`

**Aurora must do this in the Rust result path, not leave it to the model or the prompt.** A tool
that eats the context window in four turns on a large repo is precisely the experience that costs
confidence.

---

## 8. Costs, stated plainly

- Building Aurora will require the **.NET 9 SDK**. New toolchain dependency for the repo.
- Installer grows from 112 MB to roughly **130 MB** (assuming §2.3 lands; 165 MB if WPF stays).
- **Windows only.** The tools simply do not register elsewhere.
- A second language in the repo, and a second copy of an engine that also lives in QuantumHub — a
  bug fixed in one has to be carried to the other by hand.

---

## 9. Build order

1. Port the C# into `src-tauri/probes/qg-probe/` minus WPF — perception + hands only,
   `UseWPF=false`; `dotnet publish` into prebuild; register as `externalBin`
2. Rust daemon client — spawn, JSON-lines framing, correlate by `id`, restart on crash, shutdown on
   app exit
3. Halo as an Aurora overlay window + global hotkey, driven by the automatic control session
4. The 3 tools in the Rust registry, registered only when both gates are open
5. Context discipline in the result path
6. `computer_guidelines` tool + `guide.rs`, rewritten against our surface
7. Settings → Agent — the toggle, the daemon status, and which gate is closed
8. The two system-prompt blocks
9. Transcript cards, or these render as raw JSON

---

## 10. Open, decide when building

- Does the dump path need `app.manifest` for DPI awareness once WPF is gone? (§2.3)
- What the halo looks like as an Aurora window — tokens, edges, chip placement, reduced-motion
- Whether `screenshot` should auto-fire after `do` actions the way qg-probe auto re-dumps the tree,
  or stay explicit
- Trimming (`PublishTrimmed`) on the console-only exe — how small it actually gets, and whether COM
  interop survives it
