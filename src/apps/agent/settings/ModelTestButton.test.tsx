/**
 * The test-result panel must escape the model list.
 *
 * `.agw-prov-models` is a scroll container (`overflow-y: auto`), so a panel
 * positioned inside a row gets clipped at the list's edges and slides under
 * its scrollbar — the exact bug this suite pins against returning. The panel
 * is therefore portalled to `.agw-root` and fixed against the button's rect.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelTestButton } from "./ModelTestButton";
import type { ProviderTestReport } from "@/apps/agent/services/providers/provider-test";
import type { LLMModel } from "@/kernel/store/useSettingsStore";

const testProviderModel = vi.fn();
vi.mock("@/apps/agent/services/providers/provider-test", () => ({
  testProviderModel: (...args: unknown[]) => testProviderModel(...args),
}));

const MODEL = {
  id: "m1",
  providerId: "opencode",
  modelKey: "x-preview-f-free",
  label: "Ox Alpha Free",
} as LLMModel;

const PASS_REPORT: ProviderTestReport = {
  ok: true,
  wireShape: "Responses",
  resolvedType: "openai-responses",
  url: "https://opencode.ai/zen/v1/responses",
  snippet: "Aurora connection OK",
  latencyMs: 3100,
  inputTokens: 30,
  outputTokens: 48,
  reasoningRequested: true,
  reasoningReceived: true,
  warning: null,
  error: null,
};

describe("ModelTestButton", () => {
  let agwRoot: HTMLDivElement;
  let scrollList: HTMLDivElement;
  let mount: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    // Mirror the real nesting: .agw-root > scroll list > model row > button.
    agwRoot = document.createElement("div");
    agwRoot.className = "agw-root";
    scrollList = document.createElement("div");
    scrollList.className = "agw-prov-models";
    mount = document.createElement("div");
    scrollList.appendChild(mount);
    agwRoot.appendChild(scrollList);
    document.body.appendChild(agwRoot);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    agwRoot.remove();
    testProviderModel.mockReset();
  });

  const render = (model = MODEL) => {
    act(() => {
      root ??= createRoot(mount);
      root.render(<ModelTestButton model={model} />);
    });
  };

  const button = () => agwRoot.querySelector<HTMLButtonElement>(".agw-prov-test-btn");
  const panel = () => document.querySelector<HTMLElement>(".agw-prov-test-pop");

  const flush = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const waitFor = async (ready: () => boolean, what: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (ready()) return;
      await flush(4);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it("renders the result panel outside the scrolling model list", async () => {
    testProviderModel.mockResolvedValue(PASS_REPORT);
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "pass", "the pass verdict");

    const pop = panel();
    expect(pop).not.toBeNull();
    // The whole point: the panel must NOT live inside the scroll container,
    // or the container clips it and draws its scrollbar over it.
    expect(scrollList.contains(pop!)).toBe(false);
    expect(agwRoot.contains(pop!)).toBe(true);
    // Fixed against the viewport, coordinates supplied by the component.
    expect(pop!.style.right).not.toBe("");
    expect(pop!.style.top === "" && pop!.style.bottom === "").toBe(false);
  });

  it("shows the report's route and verdict", async () => {
    testProviderModel.mockResolvedValue(PASS_REPORT);
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "pass", "the pass verdict");

    const pop = panel()!;
    expect(pop.textContent).toContain("Responses");
    expect(pop.textContent).toContain("https://opencode.ai/zen/v1/responses");
    expect(pop.textContent).toContain("Aurora connection OK");
    expect(pop.textContent).toContain("3.1s");
    expect(pop.textContent).toContain("30 in / 48 out");
  });

  it("keeps the verdict without re-running the test", async () => {
    testProviderModel.mockResolvedValue(PASS_REPORT);
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "pass", "the pass verdict");

    // The verdict lives on the button itself, so it survives the panel
    // closing — and hovering back must NOT send another request.
    expect(panel()).not.toBeNull();
    expect(testProviderModel).toHaveBeenCalledTimes(1);
  });

  it("dismisses the open result instead of testing again", async () => {
    testProviderModel.mockResolvedValue(PASS_REPORT);
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "pass", "the pass verdict");
    expect(panel()).not.toBeNull();

    // A test is a real, billed request. Clicking the verdict closes it.
    act(() => button()!.click());
    expect(panel()).toBeNull();
    expect(testProviderModel).toHaveBeenCalledTimes(1);
    // The verdict itself survives on the icon, and the button now offers a re-test.
    expect(button()!.dataset.state).toBe("pass");
    expect(button()!.getAttribute("aria-label")).toBe("Test this model again");

    // Only the click AFTER the dismissal sends another request.
    act(() => button()!.click());
    await waitFor(() => testProviderModel.mock.calls.length === 2, "the second test");
  });

  it("keeps the panel shut under a pointer that is still hovering", async () => {
    testProviderModel.mockResolvedValue(PASS_REPORT);
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "pass", "the pass verdict");
    act(() => button()!.click());
    expect(panel()).toBeNull();

    // The pointer never left, so the hover that is still sitting there must not
    // re-open what was just dismissed.
    const wrapper = agwRoot.querySelector<HTMLElement>(".agw-prov-test")!;
    act(() => wrapper.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(panel()).toBeNull();
  });

  it("reports a failed test with the provider's error", async () => {
    testProviderModel.mockResolvedValue({
      ...PASS_REPORT,
      ok: false,
      snippet: "",
      error: "HTTP 401 — invalid API key",
    });
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "fail", "the fail verdict");

    expect(panel()!.textContent).toContain("HTTP 401 — invalid API key");
  });

  it("warns when the route answers but silently drops requested reasoning", async () => {
    testProviderModel.mockResolvedValue({
      ...PASS_REPORT,
      reasoningReceived: false,
      warning:
        "The model answered, but this API format returned no reasoning.",
    });
    render();

    act(() => button()!.click());
    await waitFor(() => button()!.dataset.state === "warn", "the warning verdict");

    expect(button()!.dataset.state).toBe("warn");
    expect(panel()!.textContent).toContain("reasoning missing");
    expect(panel()!.textContent).toContain(
      "The model answered, but this API format returned no reasoning.",
    );
  });
});
