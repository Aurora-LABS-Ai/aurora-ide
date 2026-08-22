//! The browser doctrine, compiled into the binary.
//!
//! Same shape and same reasoning as [`crate::tools::canvas::guide`]: standing
//! guidance, never a skill, never listed in `aurora_skill_search`. It ships as
//! a tool rather than prompt text so it costs nothing on the turns that never
//! open a browser.
//!
//! What it encodes is the set of mistakes the tools cannot prevent by
//! themselves — guessing selectors, mistaking a viewport override for a layout
//! bug, re-navigating to a page already on screen. Every rule here exists
//! because the failure it describes is SILENT: the call succeeds and the wrong
//! conclusion follows.

pub const BROWSER_GUIDE: &str = r#"# Driving the Browser panel

Aurora has ONE browser: an embedded panel in the agent window's right dock.
Never a separate window, never a second tab. It persists across turns, and the
user opens and drives it themselves too — so it is very often already open on
the page you want, showing something you did not put there.

## Start by finding out where you are

`browser_status` first, every time you are not certain. It is read-only and
cheap: it never opens the panel, never navigates, never clears the console.

It answers: is the panel open at all, what URL and title, has the page finished
loading, what size is the viewport, how many console errors and warnings this
page has produced, and whether a viewport override is in force.

`browser_navigate` to a page that is already showing does NOT reload by
default — it reports `already_there` and leaves the page alone. That is
deliberate: a reload silently throws away scroll position, form state, and the
current route of a single-page app. Pass `reload: true` when you have changed
the source and genuinely need a fresh load.

## Never invent a CSS selector

This is the rule that matters most, because breaking it fails silently.

A selector you derive from a component file can be wrong in two ways. It can
match nothing — you get an error, which is survivable. Or it can match the
WRONG element — a wrapper, a duplicate row, a hidden copy — and then the click
succeeds, the tool reports success, and you carry on from a false premise.

`browser_view` returns the elements the page actually has. Every selector it
gives you was checked against the live DOM with
`querySelectorAll(sel).length === 1` before you saw it. An element that cannot
be addressed uniquely comes back with NO selector and a note saying so, rather
than a selector that might be wrong.

Read the page, then act on what is there. Do not act on what you expect to be
there.

## What you can see is not the whole page

`browser_view` defaults to the VIEWPORT — what a person actually sees. That is
the right scope for checking a layout you just built, and the wrong scope for
"does this page contain X".

Every result states its range:

    "view_range": { "from_y": 0, "to_y": 812, "page_height": 3400, "covers_percent": 24 }

Twenty-four percent. Three quarters of that page was never in the answer. If
what you are looking for is not in the list, scroll or pass
`viewport_only: false` before concluding it does not exist.

`hidden_or_offscreen` counts elements that were skipped. `truncated` means the
list hit its cap. Neither is an error; both mean the answer is partial.

## Structure and appearance are different questions

- `browser_view` and `browser_page_outline` tell you what is THERE — text,
  roles, state, positions. They cannot tell you it looks wrong.
- `browser_screenshot` is the only thing that answers "is the spacing right,
  did the chart render, is the text unreadable on this background, does that
  column overflow". Layout and visual bugs are invisible to every text tool.
- `browser_a11y_tree` is the engine's own accessibility view — use it for
  labelling and keyboard-order questions, not as a general page reader.

If the task is "check what I built", you need a screenshot. If the task is
"click the thing", you need a selector.

## A viewport override is sticky, and it will fool you

`browser_set_viewport` renders the panel as a device frame at the size you ask
for — the panel's own background shows around it, and a screenshot is the
device and nothing else. There is no blank band to mistake for a hole in the
layout. If you ask for a frame wider than the panel it is capped at the panel's
width, and `browser_status` reports the size the page actually got.

What it will still do is fool you by lasting. The override survives every later
turn. Set it once and forget, and everything you look at from then on is
phone-width while the picture gives you no hint of it. `browser_status` reports
the override and every screenshot taken under one carries a note.

Clear it with `browser_set_viewport {"reset": true}` before judging a desktop
layout. Loading a URL clears it too.

`browser_emulate_media` behaves the same way — a forced dark-mode or print
override stays until you clear it.

## You have a visible cursor

Before a click or a fill, Aurora draws a pointer on the element you named and
plays a press there, so the person watching the panel sees the interaction
instead of the page changing by itself. You do not control it and never need to
mention it — it is removed before every screenshot, so no capture contains it.

It is worth knowing for one reason: if you name the wrong selector, the user
watches the cursor land on the wrong thing. Guessed selectors are now visibly
wrong, not just quietly wrong.

## Read what an action actually did

`browser_click` and `browser_fill` return a `changed` block, not just success.
It reports navigation with both URLs, console errors that THIS action caused
(counted as a delta, so a page that was already throwing does not frame every
later click), scroll movement, page height change when content rendered or
collapsed, and what the page is now showing:

- `text_changed` with `text_length_delta` — the rendered text differs. A label
  that swapped, a status line that appeared, a value that updated.
- `elements_added` / `elements_removed` — a menu, overlay, toast or row mounted
  or unmounted. Catches out-of-flow elements that change no height at all.
- `focus_moved_to` — what ended up focused. On its own this proves the click
  landed on a real control.
- `transient_text` — messages that appeared during the action and were gone
  again before the page was observed. This is where a short-lived toast or
  validation flash lands ("enter a valid email"); no screenshot, view or log
  read can catch these afterwards, so when a click "did nothing", read this
  first.

## Local files

`browser_navigate` takes `file://` URLs directly — Aurora serves the file
through its own `aurora-page` scheme so the page can talk back (a raw file://
page cannot, and every observation against one used to time out). The address
you see afterwards is `http://aurora-page.localhost/<path>`; that is the same
file, served live from disk, so edit-and-reload works. No local HTTP server is
needed to preview an HTML file.

`"nothing_observable_changed": true` is a real result and usually a problem. It
means the element was found and acted on and the page did not react — a dead
handler, a disabled control, or the wrong element. Do not read it as success.

When it comes back with `dom_mutations`, the DOM WAS touched but nothing it
renders differs — the shape of an attribute, class or style toggle. Inspect the
element before concluding the action did nothing.

## Act and look in ONE call

Every acting tool takes `see`, `settle_ms` and `region`, so "scroll, wait, then
look" is one call rather than three round trips:

    browser_scroll { "direction": "down", "settle_ms": 400, "see": "view" }

- `see: "view"` returns the visible elements and their verified selectors after
  the page settled, so the NEXT action can be chosen from this same result.
- `settle_ms` is how long to let the page react before observing. Default 350,
  maximum 5000. Raise it for a route change or a slow fetch. A page still
  loading is reported as such rather than waited out.
- `region` scopes the observation to the container you changed instead of the
  whole viewport.

Use `see: "none"` (the default) when you already know what the action does and
only need to know it worked. The `changed` block comes back either way.

For how it LOOKS after an action, `browser_screenshot` is still its own call —
an image has to be returned as a vision block, and only a model that can see
images may receive one.

## Console

`browser_get_console_logs` returns the buffer for the current page, including
uncaught errors with their file and line, and unhandled promise rejections.
Reading does not clear it. A page reload does.

Check it after any action that should have worked and did not. The `changed`
block already tells you how many errors an action caused; this is how you read
them.

## Order that works

1. `browser_status` — where am I, is a panel already open
2. `browser_navigate` — only if not already there
3. `browser_screenshot` — see it
4. `browser_view` — get real selectors for what you must touch
5. act, and read the `changed` block
6. `browser_get_console_logs` if something did not behave

Skip steps you already have the answer to. The point of status and the change
block is that you should rarely need a whole cycle to learn one fact.

## Notes

- Everything is scoped to the one panel; there is no window or tab argument.
- Input goes through the browser's own pipeline, so hover really paints and Tab
  really moves focus — these are not synthetic DOM events.
- Viewport and media emulation, real key and pointer input, and the
  accessibility tree all need the DevTools channel, which exists on Windows
  only. On other platforms they report that plainly rather than pretending.
"#;
