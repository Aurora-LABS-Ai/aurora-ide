/**
 * The transient-content watcher that `browser_click` / `browser_fill` install
 * across their settle window lives as two JS constants in
 * `src-tauri/src/tools/browser/mod.rs` and executes inside the page, where no
 * Rust test can reach it. This suite runs THE SHIPPED SOURCE — extracted from
 * the Rust file, not a copy — against jsdom, so a change to the constants is a
 * change to what these tests execute.
 *
 * Why it exists at all: a login toast that lived for one second was invisible
 * to every observation tool (screenshot, view, console logs all ran after it
 * was gone), and the user had to read the screen to the agent. The watcher's
 * one job is to catch exactly that.
 *
 * NOTE: reads the Rust source with readFileSync — if `tools/browser/mod.rs`
 * moves, fix the path here by hand (see .knowledge/lesson.md 2026-08-06).
 */

import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const RUST_SOURCE = `${cwd}/src-tauri/src/tools/browser/mod.rs`;

function extractConstant(name: string): string {
  const source = readFileSync(RUST_SOURCE, "utf8");
  const match = source.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  if (!match) throw new Error(`${name} not found in ${RUST_SOURCE}`);
  return match[1];
}

const WATCH_START = extractConstant("TRANSIENT_WATCH_START");
const WATCH_STOP = extractConstant("TRANSIENT_WATCH_STOP");

// The constants are IIFE expressions; indirect eval runs them against the
// jsdom globals the same way the WebView evaluates them against the page.
const start = (): boolean => (0, eval)(WATCH_START) as boolean;
const stop = (): string[] => (0, eval)(WATCH_STOP) as string[];

/** Let queued MutationObserver callbacks deliver. */
const flushMutations = () => new Promise<void>((r) => setTimeout(r, 0));

describe("transient content watcher", () => {
  beforeEach(() => {
    document.body.innerHTML = `<h1>Login</h1><button id="login">Log in</button><div id="host"></div>`;
  });

  it("reports a toast that appeared and vanished inside the settle window", async () => {
    expect(start()).toBe(true);

    const toast = document.createElement("div");
    toast.textContent = "Please enter a valid email address";
    document.getElementById("host")!.appendChild(toast);
    await flushMutations();
    toast.remove();
    await flushMutations();

    expect(stop()).toEqual(["Please enter a valid email address"]);
  });

  it("does not report content that is still on the page", async () => {
    expect(start()).toBe(true);

    const banner = document.createElement("div");
    banner.textContent = "Logged in as admin";
    document.getElementById("host")!.appendChild(banner);
    await flushMutations();

    // Still visible at observation time: `text_changed` and `view` already
    // carry it, and repeating it here would teach the model the field lies.
    expect(stop()).toEqual([]);
  });

  it("reports a live-region rewrite whose text was replaced again", async () => {
    const region = document.createElement("div");
    const textNode = document.createTextNode("idle");
    region.appendChild(textNode);
    document.getElementById("host")!.appendChild(region);

    expect(start()).toBe(true);
    textNode.data = "Saving failed — retry";
    await flushMutations();
    textNode.data = "idle";
    await flushMutations();

    expect(stop()).toEqual(["Saving failed — retry"]);
  });

  it("a fresh start forgets the previous action's records", async () => {
    expect(start()).toBe(true);
    const toast = document.createElement("div");
    toast.textContent = "old toast";
    document.getElementById("host")!.appendChild(toast);
    await flushMutations();
    toast.remove();
    await flushMutations();

    // Second action begins: its records must not inherit the first's.
    expect(start()).toBe(true);
    expect(stop()).toEqual([]);
  });

  it("stop without start answers an empty list, not an error", () => {
    // stop() cleared the state in earlier tests; calling again must be safe —
    // the Rust side calls it best-effort after every action.
    expect(stop()).toEqual([]);
  });

  it("deduplicates identical messages and caps the list", async () => {
    expect(start()).toBe(true);
    const host = document.getElementById("host")!;
    for (let i = 0; i < 3; i++) {
      const toast = document.createElement("div");
      toast.textContent = "Rate limited";
      host.appendChild(toast);
    }
    await flushMutations();
    host.innerHTML = "";
    await flushMutations();

    expect(stop()).toEqual(["Rate limited"]);
  });
});
