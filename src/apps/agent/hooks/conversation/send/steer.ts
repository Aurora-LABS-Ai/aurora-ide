/**
 * Agent Window — send pipeline: a message sent while a turn is running.
 *
 * Mid-turn injection: the text is queued instead of starting a second turn.
 * The Rust runtime drains the slot at the next tool-result boundary and
 * staples it onto the tool message, so the model sees it inline (parity with
 * the IDE).
 *
 * A steering message must be as accurate as a fresh turn: `@` file mentions
 * already ride in the text (`@rel`), staged `/` directives are consumed HERE
 * and resolved into a `<steering_context>` block on the model copy — a
 * mid-turn send used to silently drop them (they stayed staged and leaked
 * onto the NEXT turn) — and inspector picks ride the same block. Picks used
 * to wait for a fresh turn, which read as a silent drop: the pills left the
 * composer, the injected bubble showed bare text, and nothing said whether
 * the model ever saw the elements. It had not. An element block is plain text
 * and rides a tool-result boundary as well as any rule does.
 */

import type { AttachedPromptChip } from "@/apps/agent/services/threads/thread-service";
import { formatSkillReferences } from "@/apps/agent/services/runtime/agent-prompt";
import {
  effectiveExecutionMode,
  effectiveProjectRoot,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { getWorkspaceSkillToggles, resolveSkillsForPrompt } from "@/apps/agent/services/skills/skills";
import { isChatPromptCommand, isDirectiveCommand } from "@/apps/agent/adapters/prompt-commands";
import { appendImageMarkers } from "@/apps/agent/lib/render/image-markers";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  composerImages,
  useAgentAttachmentStore,
} from "@/apps/agent/store/composer/useAgentAttachmentStore";
import {
  buildCommandSelection,
  composerCommands,
  useAgentCommandStore,
} from "@/apps/agent/store/composer/useAgentCommandStore";
import {
  buildSelectionContext,
  useAgentSelectionStore,
} from "@/apps/agent/store/composer/useAgentSelectionStore";
import { buildImageRequest, buildMcpDirective, buildRuleContext } from "./context-blocks";

export interface SteerInput {
  /** The person's words, trimmed. */
  content: string;
  /** The thread whose turn is running. */
  liveThreadId: string;
  /** The composer tray this send drains. */
  stageKey: string;
  /** `@` file and folder pills from the composer. */
  fileChips: AttachedPromptChip[];
  /** The project a docked composer belongs to, when it has one. */
  projectRootHint: string | null | undefined;
}

/** Queue `content` into the running turn with everything the composer staged. */
export async function steerRunningTurn({
  content,
  liveThreadId,
  stageKey,
  fileChips,
  projectRootHint,
}: SteerInput): Promise<void> {
  const chat = useAgentChatStore.getState();
  const liveMode = chat.liveModes[liveThreadId];
  const chatSteering =
    liveMode === "chat" ||
    (!liveMode && useAgentSettingsStore.getState().auroraSurface === "chat");
  const queuedCommands = composerCommands(
    useAgentCommandStore.getState(),
    stageKey,
  ).filter(isDirectiveCommand);
  const steeringCommands = queuedCommands.filter(
    (command) => !chatSteering || isChatPromptCommand(command),
  );
  const steeringSelection = buildCommandSelection(steeringCommands);
  const steeringCommandChips = steeringCommands.map((c) => ({
    kind: c.kind,
    title: c.title,
  } satisfies AttachedPromptChip));
  if (queuedCommands.length > 0) {
    useAgentCommandStore.getState().clear(stageKey);
  }

  // Inspector picks: full context to the model (below), a compact pill
  // per element on the queued card and the injected row. Consumed now —
  // leaving them staged is what made them leak onto the next turn.
  const steeringPicks = chatSteering ? [] : useAgentSelectionStore.getState().selected;
  const steeringPickChips = steeringPicks.map((entry) => ({
    kind: "element" as const,
    title: `<${entry.element.tagName}> ${(entry.element.text ?? "").trim().slice(0, 24)}`.trim(),
    value: entry.element.selector,
    // The pick's index, so the injected row can anchor this pill at its
    // `@element:N` token in the text. Carried in `path` because that is
    // a field the Rust chip struct round-trips — a TS-only field would
    // be dropped between enqueue and the injection event.
    path: String(entry.index),
  } satisfies AttachedPromptChip));
  if (steeringPicks.length > 0) useAgentSelectionStore.getState().clear();

  const chips = [...fileChips, ...steeringCommandChips, ...steeringPickChips];

  // Staged image attachments ride the injection as `<aurora_image>`
  // markers — the same wire path `browser_screenshot` uses, so a
  // mid-turn image reaches a vision model as a real image part
  // (staging is already vision-gated at the composer). The display
  // copy carries the markers too, so the inline injected row renders
  // the same thumbnails a user bubble would.
  const steeringImages = composerImages(
    useAgentAttachmentStore.getState(),
    stageKey,
  );
  const displayWithImages = appendImageMarkers(content, steeringImages);
  if (steeringImages.length > 0) {
    useAgentAttachmentStore.getState().clear(stageKey);
  }

  // Resolve directive content the same way a fresh turn does. The
  // system prompt of an in-flight turn can't change, so the resolved
  // blocks ride inside the injected message instead of ideContext.
  const steeringSettings = useAgentSettingsStore.getState();
  const steeringRoot = effectiveProjectRoot(
    liveMode ??
      effectiveExecutionMode(
        steeringSettings.auroraSurface,
        steeringSettings.agentExecutionMode,
      ),
    chat.liveProjects[liveThreadId] ?? projectRootHint ?? chat.projectRoot,
  );
  const blocks: string[] = [];
  // Same block a fresh turn sends via ideContext — selector, tag, text
  // and clipped HTML per element, so the model can locate the source.
  const steeringSelectionBlock = buildSelectionContext(steeringPicks);
  if (steeringSelectionBlock) blocks.push(steeringSelectionBlock);
  const steeringRules = await buildRuleContext(
    steeringRoot,
    steeringSelection.ruleFilenames,
  );
  if (steeringRules) blocks.push(steeringRules);
  const steeringMcp = buildMcpDirective(steeringSelection.mcpServerNames);
  if (steeringMcp) blocks.push(steeringMcp);
  const steeringImage = buildImageRequest(steeringSelection.imageRequested);
  if (steeringImage) blocks.push(steeringImage);
  if (steeringSelection.explicitSkillKeys.length > 0) {
    try {
      const s = useAgentSettingsStore.getState();
      const resolved = await resolveSkillsForPrompt({
        enabledSkillToggles: getWorkspaceSkillToggles(s.skillToggles, steeringRoot),
        explicitSkillKeys: steeringSelection.explicitSkillKeys,
        skillsEnabled: s.skillsEnabled,
        userMessage: content,
        workspacePath: steeringRoot ?? undefined,
      });
      if (resolved.explicitSkills.length > 0) {
        blocks.push(formatSkillReferences(resolved.explicitSkills, "required_skills"));
      }
    } catch (err) {
      console.warn("[agent-window] mid-turn skill resolution failed:", err);
    }
  }
  // Tag pair is a contract with the Rust reload path
  // (`strip_steering_context` in commands/threads.rs) — it cuts this
  // block back out of the injected row's display text. (The runtime
  // adds its own mid-turn framing preamble at injection time.)
  const modelText =
    blocks.length > 0
      ? `${displayWithImages}\n\n<steering_context>\n${blocks.join("\n\n")}\n</steering_context>`
      : steeringImages.length > 0
        ? displayWithImages
        : undefined;
  void chat.enqueueMessage(liveThreadId, content, {
    modelText,
    displayText: steeringImages.length > 0 ? displayWithImages : undefined,
    chips: chips.length > 0 ? chips : undefined,
    imageCount: steeringImages.length > 0 ? steeringImages.length : undefined,
  });
}
