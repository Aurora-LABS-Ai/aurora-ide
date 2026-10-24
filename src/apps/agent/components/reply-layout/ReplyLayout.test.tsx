/**
 * Reply layout blocks (Transcript → Reply layout): facts, a flow and a note
 * drawn from the model's fence, each line still the model's own words; a
 * block with nothing to draw shows the source instead; a bad line is named.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ReplyLayout } from "./ReplyLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (el: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const fallback = <pre data-fallback>source</pre>;

describe("ReplyLayout", () => {
  it("draws facts as rows with label, value and caption, code spans intact", () => {
    const el = mount(
      <ReplyLayout
        language="aurora-facts"
        source={"Framework | Next.js 16.2.3 | App Router\nGate | `proxy.ts`\n"}
        closed
        fallback={fallback}
      />,
    );
    const tiles = el.querySelectorAll(".agw-rl-fact");
    expect(tiles).toHaveLength(2);
    expect(tiles[0].querySelector(".agw-rl-fact-label")?.textContent).toBe("Framework");
    expect(tiles[0].querySelector(".agw-rl-fact-value")?.textContent).toBe("Next.js 16.2.3");
    expect(tiles[0].querySelector(".agw-rl-fact-caption")?.textContent).toBe("App Router");
    expect(tiles[1].querySelector(".agw-rl-fact-value code")?.textContent).toBe("proxy.ts");
    expect(el.querySelector("[data-fallback]")).toBeNull();
  });

  it("draws a flow across with one step's caption open, switched by click or arrow keys", () => {
    const el = mount(
      <ReplyLayout
        language="aurora-flow"
        source={"Request\nproxy.ts | the gate\nStorefront | public || Admin | gated\nPostgreSQL\n"}
        closed
        fallback={fallback}
      />,
    );
    const steps = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panel = () => el.querySelector('[role="tabpanel"]')!;
    expect(steps.map((s) => s.textContent)).toEqual(["1Request", "2proxy.ts", "3Storefront · Admin", "4PostgreSQL"]);
    expect(steps[0].getAttribute("aria-selected")).toBe("true");
    expect(panel().textContent).toBe("");

    act(() => steps[1].click());
    expect(steps[1].getAttribute("aria-selected")).toBe("true");
    expect(panel().textContent).toBe("the gate");

    act(() => steps[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(steps[2].getAttribute("aria-selected")).toBe("true");
    expect(steps[2].getAttribute("data-branches")).toBe("2");
    expect([...panel().querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Storefront public", "Admin gated"]);
    expect(document.activeElement).toBe(steps[2]);

    act(() => steps[2].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(steps[3].getAttribute("aria-selected")).toBe("true");
    act(() => steps[3].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(steps[0].getAttribute("aria-selected")).toBe("true");
  });

  it("draws a flow with no captions as a plain path, nothing to click", () => {
    const el = mount(<ReplyLayout language="aurora-flow" source={"Request\nGate\nDatabase\n"} closed fallback={fallback} />);
    expect(el.querySelector('[role="tab"]')).toBeNull();
    expect(el.querySelector(".agw-rl-flow[data-plain]")).not.toBeNull();
    expect([...el.querySelectorAll(".agw-rl-step")].map((s) => s.textContent)).toEqual(["1Request", "→2Gate", "→3Database"]);
  });

  it("draws a note with its title, pairs and sentences", () => {
    const el = mount(
      <ReplyLayout
        language="aurora-note"
        source={"The trap\nFile | `a/(client)/x.tsx`\nURL | /x\nThe group drops out of the URL.\n"}
        closed
        fallback={fallback}
      />,
    );
    expect(el.querySelector(".agw-rl-note-title")?.textContent).toBe("The trap");
    expect(el.querySelectorAll(".agw-rl-pair")).toHaveLength(2);
    expect(el.querySelector(".agw-rl-note-text")?.textContent).toBe("The group drops out of the URL.");
  });

  it("draws bars with the number beside each and a fill sized by the share", () => {
    const el = mount(
      <ReplyLayout
        language="aurora-bars"
        source={"Client components\n`app/*.tsx` | 31 / 97\n`components/` | 155 / 193 | islands\n"}
        closed
        fallback={fallback}
      />,
    );
    expect(el.querySelector(".agw-rl-block-title")?.textContent).toBe("Client components");
    const bars = el.querySelectorAll(".agw-rl-bar");
    expect(bars).toHaveLength(2);
    expect(bars[0].querySelector(".agw-rl-bar-amount")?.textContent).toBe("31 / 97");
    const width = (bars[0].querySelector(".agw-rl-bar-fill") as HTMLElement).style.width;
    expect(Math.round(parseFloat(width))).toBe(32);
    expect(bars[1].querySelector(".agw-rl-bar-caption")?.textContent).toBe("islands");
  });

  it("draws pairs as a titled key / value table", () => {
    const el = mount(
      <ReplyLayout language="aurora-pairs" source={"Route structure\n`app/api/` | 95 handlers\n`proxy.ts` | 4 gates\n"} closed fallback={fallback} />,
    );
    expect(el.querySelector(".agw-rl-pairs .agw-rl-block-title")?.textContent).toBe("Route structure");
    const rows = el.querySelectorAll(".agw-rl-pairs .agw-rl-pair");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("dt")?.textContent).toBe("app/api/");
    expect(rows[0].querySelector("dd")?.textContent).toBe("95 handlers");
  });

  it("names a line it skipped, only once the block is finished", () => {
    const source = "Framework | Next\nno value here\n";
    const live = mount(<ReplyLayout language="aurora-facts" source={source} closed={false} fallback={fallback} />);
    expect(live.querySelector(".agw-rl-problems")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const done = mount(<ReplyLayout language="aurora-facts" source={source} closed fallback={fallback} />);
    expect(done.querySelector(".agw-rl-problems")?.textContent).toContain("no value here");
  });

  it("folds skipped lines into one count that opens to row and reason", () => {
    const el = mount(
      <ReplyLayout language="aurora-checklist" source={"done | Ship\ncomplete | Build\ntodo | A | b | c\n"} closed fallback={fallback} />,
    );
    const toggle = el.querySelector<HTMLButtonElement>(".agw-rl-problems-toggle")!;
    const list = el.querySelector<HTMLUListElement>(".agw-rl-problems-list")!;
    expect(toggle.textContent).toBe("2 lines skipped");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(list.hidden).toBe(true);
    act(() => toggle.click());
    expect(list.hidden).toBe(false);
    const rows = Array.from(list.querySelectorAll(".agw-rl-problems-row"), (r) => r.textContent);
    expect(rows).toEqual(["complete | Build", "todo | A | b | c"]);
    expect(list.querySelector(".agw-rl-problems-reason")?.textContent).toBe('"complete" is not a status; use todo, doing, done or blocked');
  });

  it("falls back to the source when nothing can be drawn, and holds space while streaming", () => {
    const empty = mount(<ReplyLayout language="aurora-facts" source={"just words\n"} closed fallback={fallback} />);
    expect(empty.querySelector("[data-fallback]")).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const pending = mount(<ReplyLayout language="aurora-facts" source={"Framework | Ne"} closed={false} fallback={fallback} />);
    expect(pending.querySelector(".agw-rl-pending")).not.toBeNull();
    expect(pending.querySelector("[data-fallback]")).toBeNull();
  });
});
