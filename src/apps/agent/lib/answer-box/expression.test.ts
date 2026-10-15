import { describe, expect, it } from "vitest";

import { BoxExpressionError, evaluateExpression, parseExpression, referencedNames } from "./expression";

const run = (text: string, scope: Record<string, number> = {}) =>
  evaluateExpression(parseExpression(text).expr, new Map(Object.entries(scope)));

describe("answer box formulas", () => {
  it("follows ordinary precedence and parentheses", () => {
    expect(run("2 + 3 * 4")).toBe(14);
    expect(run("(2 + 3) * 4")).toBe(20);
    expect(run("10 - 4 - 3")).toBe(3);
    expect(run("-2 * -3")).toBe(6);
    expect(run("people * 0.4", { people: 6 })).toBeCloseTo(2.4);
  });

  it("has the six functions and checks how many values each takes", () => {
    expect(run("round(2.456, 2)")).toBe(2.46);
    expect(run("round(2.5)")).toBe(3);
    expect(run("ceil(9.6)")).toBe(10);
    expect(run("floor(9.6)")).toBe(9);
    expect(run("min(3, 1, 2)")).toBe(1);
    expect(run("max(3, 1, 2)")).toBe(3);
    expect(run("abs(-4)")).toBe(4);
    expect(() => parseExpression("ceil(1, 2)")).toThrow(BoxExpressionError);
    expect(() => parseExpression("sqrt(4)")).toThrow(/not a function here/);
  });

  it("stops where the formula stops, so a unit can follow it on the line", () => {
    const text = "= people * 400 g";
    const { end } = parseExpression(text, 1);
    expect(text.slice(end).trim()).toBe("g");
    const money = "bill / people $";
    expect(money.slice(parseExpression(money).end).trim()).toBe("$");
  });

  it("names an unknown input and refuses to divide by zero", () => {
    expect(() => run("guests * 2", { people: 6 })).toThrow('nothing in this box is called "guests"');
    expect(() => run("1 / (people - 6)", { people: 6 })).toThrow("divides by zero");
  });

  it("never reaches JavaScript: anything outside the grammar is not a formula", () => {
    expect(() => run("constructor")).toThrow(BoxExpressionError);
    expect(() => parseExpression("alert(1)")).toThrow(/not a function here/);
    const { end } = parseExpression("1; process.exit()");
    expect(end).toBe(1);
  });

  it("lists the names a formula reads", () => {
    const names = referencedNames(parseExpression("round(bill * (1 + tip) / people, 2)").expr);
    expect([...names].sort()).toEqual(["bill", "people", "tip"]);
  });
});
