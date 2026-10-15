import { describe, expect, it } from "vitest";

import { formatBoxValue } from "./format";

describe("answer box number formatting", () => {
  it("moves grams and millilitres up a unit past a thousand", () => {
    expect(formatBoxValue(2400, "g")).toBe("2.4 kg");
    expect(formatBoxValue(1500, "g")).toBe("1.5 kg");
    expect(formatBoxValue(750, "g")).toBe("750 g");
    expect(formatBoxValue(749.6, "g")).toBe("750 g");
    expect(formatBoxValue(1250, "ml")).toBe("1.3 L");
  });

  it("prints money with the symbol in front and two decimals", () => {
    expect(formatBoxValue(53.5925, "$")).toBe("$53.59");
    expect(formatBoxValue(1234.5, "£")).toBe("£1,234.50");
    expect(formatBoxValue(-3, "€")).toBe("−€3.00");
  });

  it("reads minutes as hours past an hour", () => {
    expect(formatBoxValue(45, "min")).toBe("45 min");
    expect(formatBoxValue(116, "min")).toBe("1 h 56 min");
    expect(formatBoxValue(120, "min")).toBe("2 h");
  });

  it("follows the number with a word, picking singular or plural", () => {
    expect(formatBoxValue(1, "person/people")).toBe("1 person");
    expect(formatBoxValue(6, "person/people")).toBe("6 people");
    expect(formatBoxValue(3.5, "h")).toBe("3.5 h");
    expect(formatBoxValue(12, "%")).toBe("12%");
  });

  it("groups thousands, trims noise, and honours fixed decimals", () => {
    expect(formatBoxValue(10)).toBe("10");
    expect(formatBoxValue(0.1 + 0.2)).toBe("0.3");
    expect(formatBoxValue(1250000)).toBe("1,250,000");
    expect(formatBoxValue(2, undefined, 1)).toBe("2.0");
  });
});
