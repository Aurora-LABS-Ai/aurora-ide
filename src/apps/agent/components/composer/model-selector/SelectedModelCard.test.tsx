import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";

import { SelectedModelCard } from "./SelectedModelCard";
import type { RichOption } from "./model-option";

const mocks = vi.hoisted(() => ({ updateModel: vi.fn(), fastAvailable: vi.fn() }));
vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/apps/agent/store/settings/useAgentSettingsStore")>()),
  useAgentSettingsStore: (select: (s: { updateModel: typeof mocks.updateModel }) => unknown) =>
    select({ updateModel: mocks.updateModel }),
}));
vi.mock("@/apps/agent/services/providers/cursor-run", () => ({
  cursorFastAvailable: mocks.fastAvailable,
  resolveCursorFast: ({ reasoning }: { reasoning?: { default?: unknown } }) => ({
    ok: mocks.fastAvailable({ reasoning }),
  }),
}));

let container: HTMLDivElement;
let root: Root;

const opt = (over: Partial<RichOption>): RichOption => ({
  providerId: "deepseek",
  providerName: "DeepSeek",
  model: "deepseek-v4.1-flash",
  label: "DeepSeek V4.1 Flash",
  id: "row-1",
  vision: false,
  tools: true,
  createdAt: 0,
  sortOrder: 0,
  ...over,
});

const render = async (props: Partial<React.ComponentProps<typeof SelectedModelCard>> & { opt: RichOption }) => {
  const onFastChange = props.onFastChange ?? vi.fn();
  await act(async () =>
    root.render(
      <SelectedModelCard
        label={props.opt.label}
        providerName={props.opt.providerName}
        fastOn={false}
        {...props}
        onFastChange={onFastChange}
      />,
    ),
  );
  return { onFastChange };
};
const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
const click = async (text: string) => {
  const target = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(target, `no "${text}" button`).toBeTruthy();
  await act(async () => target!.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  mocks.updateModel.mockReset();
  mocks.fastAvailable.mockReset().mockReturnValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("offers Off and the model's levels, without a duplicate 'none'", async () => {
  await render({
    opt: opt({ reasoning: { type: "effort", levels: ["none", "low", "medium", "high"], default: "high", enabled: true } }),
  });
  expect(buttons()).toEqual(["Off", "Low", "Medium", "High"]);
});

it("writes the chosen level, and Off as reasoning disabled", async () => {
  const reasoning = { type: "effort" as const, levels: ["low", "high"], default: "high", enabled: true };
  await render({ opt: opt({ reasoning }) });
  await click("Low");
  expect(mocks.updateModel).toHaveBeenLastCalledWith("row-1", {
    reasoning: { ...reasoning, enabled: true, default: "low" },
  });
  await click("Off");
  expect(mocks.updateModel).toHaveBeenLastCalledWith("row-1", {
    reasoning: { ...reasoning, enabled: false },
  });
});

it("names X-High properly and stacks the label once there are many steps", async () => {
  await render({
    opt: opt({
      reasoning: { type: "effort", levels: ["low", "medium", "high", "xhigh", "max"], default: "max", enabled: true },
    }),
  });
  expect(buttons()).toEqual(["Off", "Low", "Medium", "High", "X-High", "Max"]);
  expect(container.querySelector(".agw-model-now-ctl")?.hasAttribute("data-dense")).toBe(true);
});

it("has no Off for a model that always reasons", async () => {
  await render({
    opt: opt({ reasoning: { type: "effort", levels: ["low", "high"], default: "low", toggleable: false } }),
  });
  expect(buttons()).toEqual(["Low", "High"]);
});

it("sets a thinking budget inline, and shows the slider only while thinking is on", async () => {
  const reasoning = { type: "budget" as const, min: 1024, default: 16_000, enabled: true };
  await render({ opt: opt({ reasoning, maxOutputTokens: 64_000 }) });
  expect(buttons()).toEqual(["Off", "1k", "4k", "8k", "16k", "Max"]);
  expect(container.querySelector('input[type="range"]')).not.toBeNull();
  await click("8k");
  expect(mocks.updateModel).toHaveBeenLastCalledWith("row-1", {
    reasoning: { ...reasoning, enabled: true, default: 8000 },
  });

  await render({ opt: opt({ reasoning: { ...reasoning, enabled: false }, maxOutputTokens: 64_000 }) });
  expect(container.querySelector('input[type="range"]')).toBeNull();
});

it("turns Cursor's Fast off when the new reasoning choice has no fast twin", async () => {
  const reasoning = { type: "effort" as const, levels: ["low", "high"], default: "low", enabled: true };
  mocks.fastAvailable.mockImplementation(({ reasoning: r }: { reasoning?: { default?: unknown } }) => r?.default !== "high");
  const { onFastChange } = await render({
    opt: opt({ providerId: CURSOR_PROVIDER_ID, providerName: "Cursor", reasoning }),
    fastOn: true,
  });
  await click("High");
  expect(onFastChange).toHaveBeenCalledWith(false);
  expect(mocks.updateModel).toHaveBeenCalled();
});

it("describes a picture model and offers no reasoning controls", async () => {
  await render({ opt: opt({ image: true, canEdit: true, tools: false, reasoning: undefined }) });
  expect(container.textContent).toContain("Replies with a picture");
  // The direct path cannot edit yet, so the card must not promise it.
  expect(container.textContent).not.toMatch(/attach/i);
  expect(buttons()).toEqual([]);
});
