/**
 * Agent Window — send pipeline: the local token estimate for a turn whose
 * provider reported no usage.
 */

import type { PromptOverhead } from "@/apps/agent/services";
import type { DbMessage, TokenUsage } from "@/apps/agent/services/threads/thread-service";
import { BASE_AGENT_SYSTEM_PROMPT } from "@/apps/agent/services/runtime/agent-prompt";
import {
  tokenService,
  stripImagePayloads,
  IMAGE_TOKEN_COST,
  type ChatMessageForCount,
} from "@/apps/agent/services/runtime/token-service";

// The Rust runtime hard-clamps EVERY tool result to 8 KiB before it enters the
// model's conversation history (`MAX_TOOL_RESULT_LENGTH` in conversation.rs).
// The UI store keeps a much larger copy (up to 512 KiB) for the rich renderers,
// so we MUST clamp to the model-history size here or the estimate overcounts a
// grep / multi_file_read / shell result by up to ~64x and the context ring
// balloons far past what the model actually receives.
const MODEL_TOOL_RESULT_CLAMP = 8_192;

/**
 * Estimate token usage for a turn the provider never reported. Many OpenAI-
 * compatible backends (Fireworks, Ollama, OpenRouter, custom) don't emit
 * `stream_options.include_usage`, so the context ring would otherwise read zero.
 * We approximate with tiktoken over the live transcript + the base system
 * prompt, and flag the result `estimated` so the UI shows it with a `~`.
 *
 * Mirrors what the runtime ACTUALLY sends the model, not what the UI stores:
 *  - every tool result is clamped to {@link MODEL_TOOL_RESULT_CLAMP} (8 KiB),
 *  - image payloads are stripped and billed flat (never raw base64),
 *  - the FULL prompt overhead is counted — the composed system prompt, the IDE
 *    context block, AND the tool schemas — not just the base system prompt.
 *    The tool schemas alone are the bulk of the ~16% gap a usage-reporting
 *    provider (DeepSeek) revealed; counting only `BASE_AGENT_SYSTEM_PROMPT`
 *    made the 80% compaction trigger fire late.
 *  - the prompt is capped at the runtime's trim budget (it drops the oldest
 *    messages once the request would exceed `window − maxOutput·1.1`), so the
 *    estimate plateaus like the real context instead of growing forever.
 *
 * `overhead` is the exact system + tool text the `AgentService` composed
 * for this turn (`AgentService.getLastPromptOverhead`); when it's null
 * (the turn died before composing) we fall back to the base system prompt.
 */
export async function estimateTurnUsage(
  messages: DbMessage[],
  modelForCount: string,
  contextWindow: number,
  maxOutputTokens: number,
  overhead: PromptOverhead | null,
): Promise<TokenUsage | null> {
  if (messages.length === 0) return null;

  // The last assistant message is this turn's completion; everything before it
  // is the prompt context the model saw.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const completionRaw =
    lastAssistantIdx >= 0 ? messages[lastAssistantIdx].content ?? "" : "";

  let imageCount = 0;

  // CRITICAL: the live store folds an ENTIRE turn (every tool call + result)
  // onto ONE assistant message. So the final assistant message carries all of
  // this turn's tool results — which are INPUT context (the model re-ingested
  // them across iterations), not output. Count them as prompt; only the final
  // assistant's TEXT is the completion. (Earlier this whole message was treated
  // as completion, dropping ~190k tokens of tool results → the "1%" bug.)
  const toCount = (m: DbMessage, idx: number): ChatMessageForCount => {
    // Each tool RESULT enters history clamped to 8 KiB (after image stripping),
    // exactly like the runtime. Fold the clamped results into `content`; pass
    // name+args via `toolCalls` so neither is double-counted.
    const toolResults = (m.tool_calls ?? [])
      .map((tc) => {
        const clean = stripImagePayloads(tc.result ?? "");
        imageCount += clean.images;
        return clean.text.slice(0, MODEL_TOOL_RESULT_CLAMP);
      })
      .join("");
    // The final assistant's text is the completion, not prompt — skip it here.
    const body =
      idx === lastAssistantIdx
        ? { text: "", images: 0 }
        : stripImagePayloads(m.content ?? "");
    imageCount += body.images;
    return {
      role: m.role,
      content: `${body.text}${toolResults}`,
      toolCalls: (m.tool_calls ?? []).map((tc) => ({
        name: tc.name,
        arguments: stripImagePayloads(tc.arguments ?? "").text,
      })),
    };
  };

  // Count ALL messages (tool results included) as prompt context; the final
  // assistant's text alone is the completion.
  const countedPrompt = messages.map(toCount);
  const completionClean = stripImagePayloads(completionRaw);
  imageCount += completionClean.images;

  // The system + IDE-context text and the tool schemas the runtime sent this
  // turn. Falls back to the base prompt alone if the turn never composed them.
  const systemText = overhead?.systemText ?? BASE_AGENT_SYSTEM_PROMPT;
  const toolSchemaJson = overhead?.toolSchemaJson ?? "";

  try {
    const [history, sys, toolSchemas, completion] = await Promise.all([
      tokenService.countMessagesTokens(countedPrompt, modelForCount),
      tokenService.countTokens(systemText, modelForCount),
      toolSchemaJson
        ? tokenService.countTokens(toolSchemaJson, modelForCount)
        : Promise.resolve({ tokens: 0 }),
      tokenService.countTokens(completionClean.text, modelForCount),
    ]);
    let promptTokens =
      history.tokens +
      sys.tokens +
      toolSchemas.tokens +
      imageCount * IMAGE_TOKEN_COST;

    // Mirror the runtime's history trim: once the request would exceed
    // `window − maxOutput·1.1`, it drops the oldest messages. The real prompt
    // can't exceed that budget, so neither should the estimate.
    const reserve = Math.ceil(maxOutputTokens * 1.1);
    const budget = Math.max(0, contextWindow - reserve);
    if (budget > 0 && promptTokens > budget) promptTokens = budget;

    return {
      promptTokens,
      completionTokens: completion.tokens,
      totalTokens: promptTokens + completion.tokens,
      estimated: true,
    };
  } catch {
    return null;
  }
}
