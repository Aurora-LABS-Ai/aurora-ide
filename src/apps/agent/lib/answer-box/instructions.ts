/**
 * What the model is told about answer boxes. One section, in the static half
 * of both system prompts (Build and Chat), so it never changes mid-conversation
 * and never costs a cache miss.
 *
 * Every line kind the parser accepts is shown here in a working example, and
 * nothing is shown that the parser would reject — `instructions.test.ts` runs
 * the examples through `parseBox` to keep it that way.
 */

/** The examples, exported so the test can parse them. */
export const ANSWER_BOX_EXAMPLES = {
  roast: `stepper people "Number of people" 6 min=1 max=30 unit="person/people"
title "Your shopping list"
row "Bone-in leg of lamb" = people * 400 g
row "Potatoes" = people * 300 g
row "Carrots" = ceil(people * 1.6)
row "Apples for crumble" = ceil(people * 0.8)
note "Amounts include you"`,
  bill: `number bill "Bill total" 186.40 min=0 prefix="$"
choice tip "Tip" 0.15 "None"=0 "10%"=0.1 "15%"=0.15 "20%"=0.2
stepper people "People" 4 min=1 max=20
let paid = bill * (1 + tip)
row "Tip" = bill * tip $
row "Total with tip" = paid $
total "Each of {people} pays" = paid / people $`,
  compare: `metric cost "Cost for two nights" low $
metric drive "Drive time" low h
metric things "Things to do" high "/10"
item "Monterey" cost=640 drive=2 things=9
item "Lake Tahoe" cost=780 drive=3.5 things=8
item "Mendocino" cost=590 drive=3 things=5
note "Sample figures, not live prices"`,
} as const;

export function answerBoxInstructions(mode: "build" | "chat"): string {
  const when =
    mode === "chat"
      ? "Use one when the answer depends on a number the user might change — how much to buy for N people, splitting a bill, a budget, a conversion, a loan or savings figure — or when they are choosing between a few options on two or three measures."
      : "Use one when an answer depends on a number the user might change — an estimate, a sizing or cost calculation, a timeout or capacity figure — or when comparing a few options on two or three measures. Most coding answers do not need one.";
  return `## Answer boxes
A small working tool inside your reply: inputs the user changes, results that recompute as they do. ${when} Do not use one for a single fixed fact, for a list with nothing to change, or for anything that should be a canvas (a report, a dashboard, a long dataset).

Write it as a fenced \`aurora-box\` block, one part per line, between your normal sentences. Say what it assumes in the sentence before it; do not repeat its numbers in prose.

\`\`\`aurora-box
${ANSWER_BOX_EXAMPLES.roast}
\`\`\`

Lines:
- \`stepper id "Label" start min=… max=… [step=…] [unit="person/people"]\` — whole numbers with − and +.
- \`number id "Label" start [min=…] [max=…] [prefix="$"] [suffix="kg"]\` — a typed amount.
- \`choice id "Label" start "Option"=value "Option"=value …\` — two to six options; start must be one of the values.
- \`let id = formula\` — a value later lines can use.
- \`title "Text"\` — a heading over the rows that follow.
- \`row "Label" = formula [unit] [dp=N]\` — a result.
- \`total "Label" = formula [unit] [dp=N]\` — the same, drawn bold. Once per box, for the row that answers the question.
- \`metric id "Label" low|high [unit]\` and \`item "Name" id=number …\` — a comparison the user can sort; \`low\` means smaller is better.
- \`note "Text"\` — one quiet line at the bottom: an assumption or a caveat.

Formulas use input and \`let\` names, numbers, \`+ - * / ( )\`, and \`round(x, places)\`, \`ceil\`, \`floor\`, \`min\`, \`max\`, \`abs\`. Labels and notes can include a formula in braces: \`"Each of {people} pays"\`. Ids are lower case.

Units format the number for you: \`g\` and \`ml\` become kg and L past 1,000; \`$ £ € ¥ ₹\` print as money with two decimals; \`min\` prints hours and minutes; \`%\`; any other word follows the number, and \`"person/people"\` picks the right form. Never round or format inside the formula to make it look right — write the quantity, give the unit.

Two more shapes:

\`\`\`aurora-box
${ANSWER_BOX_EXAMPLES.bill}
\`\`\`

\`\`\`aurora-box
${ANSWER_BOX_EXAMPLES.compare}
\`\`\`

Rules: one box per question; inputs first, then results; at most about twelve rows; sample or assumed numbers say so in a \`note\`. A line the box cannot read is skipped and shown to the user as an error, so write only the lines above.`;
}
