# Interactive reports

Write an `aurora-report` fence with one JSON object. JSON is data, not JavaScript. The same
object can be used in a React artifact as `<Report spec={spec} />` from `aurora/canvas`.

## Contract

- `title` is required; `subtitle` and `source` are optional. State provenance and period.
- `data` is an array of flat records. Cells are finite numbers, text, booleans or null.
  Preserve numbers as numbers, with units in labels or formats. Missing values are null.
- `filters` is optional: `{field, label, kind}`. Kinds: `select`, `multi`, `search`, `range`,
  `date`. Date filters require ISO calendar dates. Controls derive options from the data.
- `sections` contains `{title?, description?, view?, blocks}`. Sections with the same `view`
  label switch together; unlabelled sections are always shown. Use views for alternate
  analyses, not to hide the conclusion. The active filters apply to every view.

Block types:

| type | Fields |
|---|---|
| metrics | `items: [{label, field?, aggregate?, format?, previous?, note?, tone?}]` |
| chart | `title, kind, x, y: [field], format?, aggregate?, xLabel?, yLabel?, description?` |
| table | `title, columns: [{key,label,format?,total?}], pageSize?, searchable?, details?: [field]` |
| text | `text` |
| note | `text, title?, tone?` |
| facts | `items: [{label,value}]` |
| list, steps, timeline, tree | `items: [{title,detail?,when?,status?,children?}]` |

Metrics aggregate the filtered records. Aggregates: `sum`, `count`, `average`, `min`, `max`,
`distinct`. Default is sum with a field, count without one. `previous` is a real, comparable
baseline, never a made-up improvement. A positive change is not automatically good.
Comparisons to a fixed previous value are hidden for filtered subsets, whose baselines differ.

`format` is `{style?, currency?, digits?}`. Styles: `number`, `currency`, `percent`, `bytes`,
`duration`. Percent values are fractions (0.25 = 25%). Duration values are milliseconds.
Currency is an uppercase three-letter code, default USD. Digits range 0–6, default 2.
Use 4 or more digits for small royalty amounts. Tone: neutral, info, good, warn, bad.

## Charts

Kinds: `column`, `bar`, `line`, `area`, `stacked-column`, `stacked-bar`, `donut`, `scatter`,
`heatmap`, `funnel`. `x` is the category field; `y` lists one to six numeric measure fields.
Duplicate categories aggregate by sum; optional `aggregate` is sum, average or count.
Measures on one axis must use comparable units; separate currency and count charts.
Scatter uses numeric x values directly. Donut and funnel require one nonnegative measure.
Keep chronological rows in actual order. A line's missing measurement remains a gap.
Magnitude axes include zero and preserve negatives. Use a small number of categories for
part-to-whole charts. If data contains negatives, use bars or lines instead of a donut.

Charts expose actual values on pointer or keyboard focus and provide a data table. Series
legends toggle visibility. Selecting a mark filters the report's metrics and tables to that
category; selecting it again or Clear selection restores all categories. Charts retain the
filtered overview so the reader can select a different category. Report filters update all
parts; table search and sorting apply only to that table. Table totals use all matching rows,
including rows on other pages. `details` makes row inspection available. Empty results have
reset controls. Interaction changes local view state and does not call tools or modify data.

## Composition and limits

Lead with the answer, then useful figures, a chart and the detailed table where relevant.
Use charts for a real quantitative question. Headings, rows and spacing carry structure;
do not wrap every item in a card. A complete report can run directly inside the conversation.

The contract rejects unknown fields, references to absent data fields, incompatible numeric
data and malformed blocks. It supports 2,000 records, 64 fields per record, 24 sections and
64 blocks, with at most 512,000 JSON characters in a reply. Table pages hold 5–100 rows.
These are rendering limits, not permission to fabricate, truncate or summarize source data
without saying so. For larger datasets use a purpose-built artifact or an exported file.

## Components for custom React canvases

The same reporting parts are exported from `aurora/canvas`:

- `Report({spec})` renders the contract above, including connected controls.
- `Chart({title,kind,x,y,data,format?,aggregate?,xLabel?,yLabel?,description?,selected?,onSelect?})`.
- `DataTable({title,columns,rows,pageSize?,searchable?,details?,onSelect?})`.
- `Metric({label,value,format?,previous?,note?,tone?})` and `MetricGrid({children})`.
- `SearchField({label,value,onChange,disabled?})`.
- `SelectField({label,value,options:[{value,label}],onChange,disabled?})`.
- `MultiSelect({label,value:[string],options:[{value,label}],onChange,disabled?})`.
- `RangeField({label,value:{min:string,max:string},onChange,kind?:"number"|"date",disabled?})`.
- `Toggle({label,checked,onChange,disabled?})`.

React controls are controlled props: keep their values in `useState` and derive all dependent
components from the same data. The declarative Report already does this for ordinary reports.

The following complete example reproduces the supplied royalty totals with selectable
platforms, stream ranges, two chart views, sortable columns, totals and row details:
