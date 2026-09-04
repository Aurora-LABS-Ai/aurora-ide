//! The canvas authoring guide, returned verbatim by `canvas_guidelines`.
//!
//! One home for this text. The system prompt points at the tool; the tool
//! returns this.
//!
//! ONE deliberate exception: the "pick the cheapest kind that works" rule below
//! is also stated in `agent-prompt.ts`'s `CANVAS_INSTRUCTIONS`. It has to be,
//! because it is the only line here that decides something BEFORE this tool is
//! called — a model that has already chosen `react` and called the guide can no
//! longer be told to have chosen `markdown`. Left only here, the encouraging
//! half of the choice ("prefer react for datasets", in the `present_artifact`
//! description) was visible at decision time and the sobering half was not.
//!
//! Both copies are pinned: `the_kind_choice_rule_is_stated_up_front` below, and
//! `agent-prompt.test.ts`. Change the wording in one and a test fails.

pub const CANVAS_GUIDE: &str = r##"# Authoring a live canvas

A canvas is a `react` artifact: ONE component file that Aurora compiles and RUNS
in the Canvas panel beside the conversation. Unlike every other artifact kind,
which is displayed as you authored it, this one is alive — controls work, tables
sort, filters filter.

It is saved to the conversation and survives forever. Reopen the thread in a
month and it is still there, still running. You can read your own source back
with `read_artifact` (call it with no `artifactId` to list what this
conversation has) and revise it with exact-text patches.

## When a canvas is the right answer

Use one when the output is a **standalone thing the user will look at**, not a
step toward something else:

- Quantitative analysis, metrics breakdowns, benchmark results
- Investigations that end in structured findings — billing, security, incidents
- Comparison tables past a handful of rows
- Results from MCP tools where the data IS the deliverable
- Anything the reader will want to sort, filter, expand, or step through

If you are about to write a large markdown table, that is a canvas.

Do **not** use one when:

- The user asked for a specific deliverable — a code fix, a PR, a drafted reply
- The user asked for work in another tool ("make me a Datadog dashboard")
- You are mid-debugging and findings merely emerged along the way
- The data was an intermediate step toward a different answer
- The answer is short, or is prose

Pick the cheapest kind that works: `markdown` for a document, `mermaid` for a
diagram, `react` only when it needs to be interactive or when layout carries
meaning that text cannot.

## The contract the compiler enforces

Your source is compiled before it is saved. If it does not compile, **nothing is
saved** and you get the errors back — fix them and retry.

- **Default-export the top-level component**: `export default function Report() {}`
- **Imports are limited to `aurora/canvas` and `react`.** No npm packages, no
  relative imports, no Node built-ins. Any other import is a compile error.
  `aurora/canvas` is the component surface described below and is what you
  should be building from; reach for `react` only for `useState`/`useMemo`.
- **No network.** `fetch`, `XMLHttpRequest`, and WebSockets are blocked by the
  sandbox's policy, not merely discouraged. Embed the data in the file.
- One file. There are no helper modules to create.
- TypeScript syntax is supported, but **types are not checked yet** — a wrong
  prop name or a bad field access compiles and then throws at run time. Do not
  lean on the compiler to catch those. Read your own data access carefully, and
  guard against missing fields and empty arrays.

Runtime crashes are reported back into the panel with the stack, so a canvas
never fails silently — but a crash is still a broken deliverable.

## Build from `aurora/canvas`, not from raw divs

The panel is narrow, sits beside a conversation, and has to look like part of
the app. Use the components. They already carry the spacing, type scale,
theme colours, hover and focus states, keyboard support, and narrow-width
behaviour — so a canvas assembled from them is correct by default, and one
hand-built from `<div style={…}>` is a different-looking product every time.

```tsx
import { Canvas, Section, List, Row, Stats, Stat, Table, Badge, Note, Text, Code } from "aurora/canvas";

export default function Report() {
  return (
    <Canvas
      title="Largest source files"
      subtitle="Ranked by line count"
      source="Repo scan at HEAD · 2026-08-06"
    >
      <Stats>
        <Stat label="Files scanned" value={1284} />
        <Stat label="Lines in top 12" value={9877} unit="lines" note="18% of the repo" />
      </Stats>

      <Section title="Ranked" description="Largest first.">
        <List>
          <Row
            rank={1}
            title="gui/renderer/styles.css"
            description="Design tokens, sidebar layout, roster rows, detail panels."
            badge="UI"
            value={1391}
            unit="lines"
          />
        </List>
      </Section>
    </Canvas>
  );
}
```

**What each one is for**

- `Canvas` — the frame. Owns the single `h1`. Pass `source` whenever numbers
  came from somewhere: a finding without provenance is an opinion.
- `Section` — grouping by whitespace and rhythm. Not a box.
- `List` + `Row` — a ranked or itemised list, separated by hairlines. This is
  the right shape for "here are N things with a metric each". Do **not** build
  that as a column of bordered cards; there is no `Card` component precisely
  because a wall of identical cards is the failure mode.
- `Stats` + `Stat` — the two or three headline numbers. `label` is required.
- `Table` — many rows, several columns, sortable by clicking a header. Use it
  whenever the reader might want a different order.

  ```tsx
  <Table
    caption="Source files by line count"          // required
    columns={[
      { key: "rank",  header: "#" },              // `label` also accepted
      { key: "path",  header: "File" },
      { key: "lines", header: "Lines" },          // numbers detected: right-aligned, sorts numerically
      { key: "area",  header: "Area" },
    ]}
    rows={files.map((f) => ({
      rank: f.rank,
      path: <code>{f.path}</code>,                // cells take components, not just strings
      lines: f.lines,
      area: <Badge tone="info">{f.area}</Badge>,
    }))}
  />
  ```

  Cells accept anything React renders — `<code>`, `<Badge>`, `<Text>`, or a raw
  element for something like a proportion bar. Column type and sortability are
  worked out from the data: a column of numbers right-aligns and sorts
  numerically, and a column of components is not offered as sortable. You only
  pass `align` or `numeric` to override that.
- `BarChart` — ranked horizontal bars, scaled to the largest value. The honest
  default for "which of these is biggest". Requires `title`; pass `unit` and
  `source` too.
  ```tsx
  <BarChart
    title="Lines of code by file" unit="lines" source="Repo scan at HEAD"
    data={files.map((f) => ({ label: f.name, value: f.lines }))}
  />
  ```
- `Bar` — a single proportion, e.g. inside a table cell:
  `<Bar value={f.lines} max={largest} />`. Never hand-build one from divs.
- `Sparkline` — an inline trend: `<Sparkline label="Weekly errors" values={[…]} />`.
- `Facts` + `Fact` — labelled values that are not a table:
  `<Facts><Fact label="Branch" value="main" /></Facts>`.
- `Timeline` + `Event` — ordered events: `<Event when="14:02" title="Deploy failed" tone="bad" />`.
- `Tabs` — for content competing for the same space:
  `<Tabs tabs={[{ id: "a", label: "Errors", content: <…/> }]} />`.
- `Detail` — progressive disclosure: `<Detail summary="Full trace">…</Detail>`.
  Put the long evidence behind a short claim here rather than dropping it.
- `Image` — a picture, with what it shows and where it came from:
  `<Image src="…" alt="Requests per second, rising after the 14:02 deploy" caption="…" source="…" />`.
  `alt` is required for the same reason `Stat` requires a label. A file that
  cannot be loaded renders a named absence carrying the path, so a figure never
  goes silently missing.
- `Cite` — a numbered citation, straight after the claim it supports:
  `…rose by a third.<Cite n={1} href="https://example.com/report">Example, 2026</Cite>`
  You supply the number; the SDK holds no state between components. Clicking one
  opens the page in the user's browser.
- `Quote` — a passage in the source's own words, with attribution:
  `<Quote from="Fred Brooks" where="The Mythical Man-Month, ch. 2">…</Quote>`.
  `from` is required — an unattributed quotation is just text in italics.
- `Columns` — side by side on a wide panel, stacked when narrow.
- `Divider` — a rule between unrelated groups. Rarely needed; whitespace first.
- `Badge` — short qualifier. `tone`: `neutral | info | good | warn | bad`.
- `Note` — a caveat, a definition, a consequence. Takes a `tone`.
- `Text`, `Code` — prose and inline identifiers.
- `useHostTheme()` — theme colours as values, for the rare raw element.

**Tone is the whole colour system.** `neutral | info | good | warn | bad` on
`Badge`, `Note`, `Stat`, `Bar`, `BarChart` data, `Event`. Never choose a colour;
choose a tone, and it matches everywhere. `neutral` is the default and stays
untinted — colour should mean something happened, not that a component exists.

Components take no `style` or `className`. If you genuinely need something
the surface does not offer, write a raw element and colour it with
`var(--agw-text)`, `var(--agw-border)`, `var(--agw-surface)` and friends —
never a hard-coded hex, which looks broken the moment the user switches to a
light theme.

## Standards the components cannot enforce for you

- **Never render an empty state.** `Section`, `List`, `Stats`, and `Table`
  disappear when they have no children or no rows, so omitting is automatic —
  but if the WHOLE canvas would be empty, do not build one. Say what data you
  are missing and ask for it.
- **Label every number.** `Stat` and `Table` make you supply labels; make them
  say something. "p95 latency (ms)" beats "Latency". Put units in column
  headings: `Size (KB)`.
- **One thing leads.** Two or three `Stat`s at the top, then detail. If
  everything is a `Row`, nothing is the answer.
- **Write for the reader**, not about your process. No "here is what I found",
  no tool names, no step numbers.
- **Colour is never the only signal.** A `bad` tone plus the word is a state; a
  red dot alone is a guess.

Before you finish: does one thing stand out, is every number labelled and
sourced, and would the reader know what to do next?

## Presenting it

Call `present_artifact` with `kind: "react"`. The Canvas panel opens on its own —
do not tell the user to open it. In your reply, say in one line what the canvas
shows and what you concluded from it. Do not restate its contents in chat; the
canvas is the artifact, your message is the summary."##;
