import { describe, expect, it } from "vitest";

import { parseBox } from "./parse";

const complete = (source: string) => parseBox(source, { complete: true });

describe("reading an answer box", () => {
  it("reads every kind of line", () => {
    const spec = complete(`stepper people "Number of people" 6 min=1 max=30 unit="person/people"
number bill "Bill total" 186.40 min=0 prefix="$"
choice tip "Tip" 0.15 "None"=0 "15%"=0.15
let paid = bill * (1 + tip)
title "For {people}"
row "Lamb" = people * 400 g
total "Each pays" = paid / people $ dp=2
metric cost "Cost" low $
item "Monterey" cost=640
note "Sample figures"`);
    expect(spec.errors).toEqual([]);
    expect(spec.parts.map((p) => p.kind)).toEqual([
      "stepper", "number", "choice", "let", "title", "row", "row", "metric", "item", "note",
    ]);
    const stepper = spec.parts[0];
    expect(stepper).toMatchObject({ id: "people", label: "Number of people", value: 6, min: 1, max: 30, unit: "person/people" });
    expect(spec.parts[2]).toMatchObject({ options: [{ label: "None", value: 0 }, { label: "15%", value: 0.15 }] });
    expect(spec.parts[5]).toMatchObject({ unit: "g", emphasis: false });
    expect(spec.parts[6]).toMatchObject({ unit: "$", places: 2, emphasis: true });
  });

  it("skips a bad line, names it, and keeps the rest of the box", () => {
    const spec = complete(`stepper people "People" 6 min=1 max=30
slider size "Size" 3
row "Lamb" = guests * 400 g
row "Potatoes" = people * 300 g`);
    expect(spec.parts.map((p) => p.kind)).toEqual(["stepper", "row"]);
    expect(spec.errors).toEqual([
      { line: 2, message: expect.stringContaining('"slider" is not a line this box knows') },
      { line: 3, message: 'nothing in this box is called "guests"' },
    ]);
  });

  it("says when a value is used before the line that defines it", () => {
    const spec = complete(`stepper n "N" 2 min=1 max=9
row "Double" = twice
let twice = n * 2`);
    expect(spec.errors).toEqual([{ line: 2, message: '"twice" is used before the line that defines it' }]);
  });

  it("refuses a name used twice, a choice that starts off its options, and a function name as an id", () => {
    const spec = complete(`stepper n "N" 2 min=1 max=9
number n "Again" 3
choice tip "Tip" 0.3 "None"=0 "15%"=0.15
stepper round "R" 1 min=0 max=2`);
    expect(spec.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(spec.errors[1].message).toBe("the starting value 0.3 is not one of the options");
  });

  it("holds back a half-written last line while the box is still streaming", () => {
    const partial = `stepper people "People" 6 min=1 max=30\nrow "Lamb" = people * 4`;
    const streaming = parseBox(partial, { complete: false });
    expect(streaming.parts.map((p) => p.kind)).toEqual(["stepper"]);
    expect(streaming.errors).toEqual([]);
    const lineDone = parseBox(`${partial}00 g\n`, { complete: false });
    expect(lineDone.parts.map((p) => p.kind)).toEqual(["stepper", "row"]);
  });

  it("ignores blank lines and comments, and reports items without metrics", () => {
    const spec = complete(`# a comment
// another

item "Monterey" cost=640`);
    expect(spec.parts).toEqual([]);
    expect(spec.errors).toEqual([{ line: 4, message: '"cost" is not a metric in this box' }]);
  });

  it("keeps quotes and braces honest", () => {
    expect(complete(`title "Unclosed`).errors[0].message).toBe("the title is missing its closing quote");
    expect(complete(`title "Say \\"hi\\""`).parts[0]).toMatchObject({ text: ['Say "hi"'] });
    expect(complete(`title "For {people"`).errors[0].message).toBe("a { in the text is never closed");
  });
});
