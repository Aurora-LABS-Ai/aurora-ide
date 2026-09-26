import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSettings } from "./AgentSettings";
import { SettingsQueryContext } from "./settings-search";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";

vi.mock("./AgentGeneralSettings", () => ({ AgentGeneralSettings: () => <p>General controls</p> }));
vi.mock("./CodeIndexCard", () => ({ CodeIndexCard: () => <p>Index controls</p> }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useAgentUiStore.setState({ agentSettingsTab: "general" });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("arrow navigation moves selection and focus and restores the saved category", async () => {
  await act(async () => root.render(<AgentSettings />));
  const general = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
  general.focus();
  await act(async () => general.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  const selected = container.querySelector('[role="tab"][aria-selected="true"]')!;
  expect(selected.textContent).toBe("Code index");
  expect(document.activeElement).toBe(selected);
  expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(selected.id);
  expect(useAgentUiStore.getState().agentSettingsTab).toBe("code-index");
  await act(async () => root.render(null));
  await act(async () => root.render(<AgentSettings />));
  expect(container.textContent).toContain("Index controls");
  expect(container.textContent).not.toContain("General controls");
});

it("settings search can reach controls from both categories", async () => {
  await act(async () => root.render(<SettingsQueryContext.Provider value="output"><AgentSettings /></SettingsQueryContext.Provider>));
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.textContent).toContain("Index controls");
  expect(container.textContent).toContain("General controls");
});
