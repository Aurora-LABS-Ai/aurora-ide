/**
 * Agent Window — the turn when the conversation's model IS an image model.
 *
 * `useAgentWindowSend` hands off here the moment it resolves the pin to an
 * image model, before any language-model machinery (context blocks, tool
 * rosters, streaming). There is nothing to stream: the reply is one picture,
 * made by one call. This runs the optimistic transcript around that call —
 * the user's bubble, a reply whose only row is the silk placeholder at the
 * requested aspect, then the picture settled into the same row — and closes
 * the live turn the way a streamed one closes.
 *
 * Only the current message is sent (an image model reads no history), and the
 * Rust command owns persistence, the Canvas artifact and the title. See
 * `src-tauri/src/commands/image_direct.rs`.
 */

import type { DbMessage, DbThread } from "@/apps/agent/services/threads/thread-service";
import type { AgentExecutionMode } from "@/apps/agent/services/runtime/agent-execution-mode";
import {
  generateImageDirect,
  type ImageDirectResult,
} from "@/apps/agent/services/providers/image-direct";
import type { ImageModel, ImageProvider } from "@/apps/agent/services/providers/image-providers";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { settleImageEvent, type DirectImageEvent, type TimelineEvent } from "@/apps/agent/components/conversation/timeline";

export interface DirectImageTurnInput {
  threadId: string;
  prompt: string;
  provider: ImageProvider;
  model: ImageModel;
  /** The conversation's pin, `"<providerId>:<modelKey>"`. */
  modelSelection: string;
  seed?: DbThread;
  projectRoot: string | null;
  executionMode: AgentExecutionMode;
}

const genId = () => Math.random().toString(36).slice(2, 11);
const nowIso = () => new Date().toISOString();

/** `WIDTHxHEIGHT` → `[w, h]`; square when the model states no size. */
function reservedShape(model: ImageModel): [number, number] {
  const size = model.defaultSize ?? model.sizes?.[0] ?? "";
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(size);
  if (!match) return [1, 1];
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? [width, height] : [1, 1];
}

function timelineOf(message: DbMessage): TimelineEvent[] {
  const raw = (message as { timeline?: unknown }).timeline;
  return Array.isArray(raw) ? (raw as TimelineEvent[]) : [];
}

export async function runDirectImageTurn(input: DirectImageTurnInput): Promise<void> {
  const { threadId, prompt, provider, model, modelSelection } = input;
  const store = useAgentChatStore.getState();
  store.beginTurn(threadId, input.seed, input.projectRoot, input.executionMode);

  store.appendTurnMessage(threadId, {
    id: genId(),
    role: "user",
    content: prompt,
    timestamp: nowIso(),
  });

  const [width, height] = reservedShape(model);
  const imageId = genId();
  const pending: DirectImageEvent = {
    kind: "image",
    id: imageId,
    status: "pending",
    width,
    height,
    prompt,
    model: model.modelKey,
  };
  const assistantId = genId();
  store.appendTurnMessage(threadId, {
    id: assistantId,
    role: "assistant",
    content: "",
    timestamp: nowIso(),
    tool_calls: [],
    timeline: [pending],
  });
  store.setThreadActivity(threadId, { label: "Making the picture…" });

  const settle = (patch: (event: DirectImageEvent) => DirectImageEvent) =>
    useAgentChatStore.getState().patchTurnMessage(threadId, assistantId, (m) => ({
      ...m,
      timestamp: nowIso(),
      timeline: settleImageEvent(timelineOf(m), imageId, patch),
    }));

  let result: ImageDirectResult | null = null;
  try {
    result = await generateImageDirect({
      threadId,
      prompt,
      provider,
      model: model.modelKey,
      size: model.defaultSize ?? null,
      modelSelection,
    });
    settle((event) => ({
      ...event,
      status: "ready",
      width: result!.width,
      height: result!.height,
      asset: result!.asset,
      path: result!.path,
      mediaType: result!.mediaType,
      artifactId: result!.artifactId,
      model: result!.model,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    settle((event) => ({ ...event, status: "failed", error: detail }));
  } finally {
    const s = useAgentChatStore.getState();
    // Rail first, then close the live turn — the same order a streamed turn
    // uses, so the chat never blinks out of the rail during the hand-off.
    await s.refreshThreads();
    s.endTurn(threadId);
    s.noteTurnComplete(threadId);
    if (result) {
      // The Canvas already holds the picture on disk; pull the bundle so the
      // "Open in Canvas" link and the dock's list agree without a reopen.
      void useAgentArtifactStore.getState().absorbRuntimeWrite(threadId);
    }
  }
}
