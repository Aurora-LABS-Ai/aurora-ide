//! The browser doctrine, compiled into the binary.
//!
//! Same shape and same reasoning as [`crate::tools::canvas::guide`]: standing
//! guidance, never a skill, never listed in `aurora_skill_search`. It ships as
//! a tool rather than prompt text so it costs nothing on the turns that never
//! open a browser.
//!
//! What it encodes is the set of mistakes the tools cannot prevent by
//! themselves — guessing selectors, mistaking a viewport override for a layout
//! bug, re-navigating to a page already on screen, reading a spinner as the
//! finished page. Every rule here exists because the failure it describes is
//! SILENT: the call succeeds and the wrong conclusion follows.

pub const BROWSER_GUIDE: &str = r#"# Driving the Browser panel

Aurora has ONE browser: an embedded panel in the agent window's right dock.
Never a separate window, never a second tab. It persists across turns, and the
user opens and drives it themselves too — so it is very often already open on
the page you want, showing something you did not put there.

## Invoke browser tools through call_tool

Every `browser_*` tool is optional. Discover its argument schema with
`tool_search`, then execute it through `call_tool`. Examples below name the
target operation and its arguments; they are not direct tool calls. For example,
`browser_status` means `call_tool({"name":"browser_status","arguments":{}})`.
Discovery returns schemas, not execution results. Reuse schemas still in context;
use `select:exact_name` to retrieve a missing one.

## Start by finding out where you are

`browser_status` first, every time you are not certain. It is read-only and
cheap: it never opens the panel, never navigates, never clears the console.

`browser_navigate` to a page that is already showing does NOT reload by
default — it reports `already_there` and leaves the page alone. Pass
`reload: true` when you have changed the source and genuinely need a fresh
load. Navigate waits for the new document to finish loading (up to 10s) and
reports `load_ms`; if `load_complete` is false, the page is still rendering.

## Never invent a CSS selector

This is the rule that matters most, because breaking it fails silently.

A selector you derive from a component file can match nothing — survivable —
or match the WRONG element, and then the click succeeds on the wrong thing.

`browser_view` returns the elements the page actually has, each with a
selector checked against the live DOM (`querySelectorAll(sel).length === 1`)
before you see it. Pass `query: "save"` to narrow to controls whose text, id
or value contains a word. `browser_click` also takes `text` instead of a
selector — the visible label of the control — which is the right choice for a
button or link you can name.

Read the page, then act on what is there.

## What you can see is not the whole page

`browser_view` defaults to the VIEWPORT. Every result states its range:

    "view_range": { "from_y": 0, "to_y": 812, "page_height": 3400, "covers_percent": 24 }

If what you are looking for is not in the list, scroll or pass
`viewport_only: false` before concluding it does not exist.

## Input is real input

`browser_click` presses the element with the browser's own pointer: pointerdown,
mousedown, focus, pointerup, mouseup, click — what a person's click produces.
Menus, dropdowns, tabs and switches built on pointer events open. Before it
presses, it checks what is painted at the press point; if a dialog backdrop, a
cookie banner or a sticky bar covers the target, the call FAILS and names the
covering element rather than clicking that. Dismiss it (usually
`browser_press_key {"key": "Escape"}`) and try again. `button: "right"` opens a
context menu; `double: true` double-clicks.

`browser_fill` sets a field's whole value and reads it back: `value_after` is
what the field holds now, `value_matches` says whether that is what you sent.
A false there means the page reformatted or rejected it — read the field's rules
before sending it again. Selects take an option value or its visible text;
checkboxes take "true"/"false". `submit: true` submits the form afterwards.

`browser_type` types keystrokes into the focused field (or `selector`), one key
event per character, and APPENDS. Use it for search-as-you-type, command
palettes, rich editors, and anything that listens to keydown. For a plain
form field, `browser_fill` is faster and replaces the old value.

`browser_press_key` presses one key or chord: "Enter", "Escape", "Tab",
"Shift+Tab", "Control+a", "ArrowDown", "F5", or a single character. Real focus
moves, so the returned `focusTrail` is the page's actual keyboard path.

## Wait for the page, do not guess at it

`browser_wait_for` blocks until a condition holds — `selector` visible (or
`state: "hidden"` for a spinner to go), `text` on the page, `url_contains` for
a route change — up to `timeout_ms` (default 10s). Use it after any action that
starts a fetch or a transition, BEFORE the screenshot. A screenshot of a loading
state read as the finished page is the most common false bug report.

Every acting tool also takes `settle_ms` (default 350, max 5000) and
`see: "view"`, so "click, wait, then look" is one call:

    browser_click { "text": "Save", "settle_ms": 800, "see": "view" }

## Read what an action actually did

Acting tools return a `changed` block, not just success:

- `navigated_to` / `navigated_from` — the URL moved.
- `new_console_errors` with `last_error` — errors THIS action caused.
- `text_changed`, `form_values_changed`, `elements_added` /
  `elements_removed`, `focus_moved_to`, `scrolled_to_y`, `page_height_delta`.
- `transient_text` — messages that appeared during the action and were gone
  again before the page was observed: a toast, a validation flash. When a click
  "did nothing", read this first.

`"nothing_observable_changed": true` is a real result and usually a problem —
a dead handler, a disabled control, or the wrong element. With
`dom_mutations` beside it, the DOM was touched but nothing rendered differs:
inspect the element before concluding the action did nothing.

## Ask the page directly

`browser_evaluate` runs JavaScript in the page and returns the result as JSON:
an expression (`document.title`) or a body with `return`. Promises are
awaited, DOM nodes come back described, a thrown error comes back with its
line. Use it to read application state, call a page function, count rows,
test a selector, or measure a box. Prefer the acting tools for clicks and
typing — they go through real input and report what changed.

## Structure and appearance are different questions

- `browser_view`, `browser_page_outline`, `browser_evaluate` tell you what is
  THERE. They cannot tell you it looks wrong.
- `browser_screenshot` is the only thing that answers "is the spacing right,
  did the chart render, does that column overflow". `selector` crops to one
  element (dialogs included); `full_page: true` captures the whole document,
  downscaled.
- `browser_a11y_tree` is the engine's own accessibility view.

## A viewport override is sticky, and it will fool you

`browser_set_viewport` renders the panel as a device frame at the size you ask
for. The override survives every later turn: set it once and forget, and
everything you look at from then on is phone-width. `browser_status` reports
it and every screenshot under one carries a note. Clear it with
`browser_set_viewport {"reset": true}` before judging a desktop layout.
`browser_emulate_media` behaves the same way.

## You have a visible cursor

Before a click or a fill, Aurora draws a pointer on the element and plays a
press there, so the person watching the panel sees the interaction. It is
removed before every screenshot. If you name the wrong element, the user
watches the cursor land on the wrong thing.

## Local files

`browser_navigate` takes `file://` URLs directly — Aurora serves the file
through its own scheme so the page can talk back. The address you see is
`http://aurora-page.localhost/<path>`; edit-and-reload works.

## Console

`browser_get_console_logs` returns the buffer for the current page, including
uncaught errors with file and line, and unhandled rejections. Reading does not
clear it; a reload does.

## Order that works

1. `browser_status` — where am I, is a panel already open
2. `browser_navigate` — only if not already there
3. `browser_screenshot` — see it
4. `browser_view` — get real selectors for what you must touch
5. act, read the `changed` block; `browser_wait_for` what should follow
6. `browser_get_console_logs` if something did not behave

## Notes

- Everything is scoped to the one panel; there is no window or tab argument.
- Real pointer and key input, viewport and media emulation, full-page
  capture, script evaluation with error locations, and the accessibility tree
  all use the DevTools channel, which exists on Windows only. Elsewhere the
  tools say so plainly and fall back to script where one exists.
"#;
