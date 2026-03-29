import type {
  AssistantMessage,
  ChatRequest,
  ChatResponse,
  ProviderConfig,
} from "./types";
import type { RustProviderRequest, RustProviderResponse } from "./rust-contract";

export function buildRustProviderRequest(
  config: ProviderConfig,
  request: ChatRequest,
  stream: boolean,
): RustProviderRequest {
  return {
    provider: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      customHeaders: config.customHeaders,
      customParams: config.customParams,
      defaultMaxTokens: config.defaultMaxTokens,
      defaultTemperature: config.defaultTemperature,
      model: config.model,
      providerType: config.providerType,
      supportsThinking: config.supportsThinking,
    },
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      reasoningContent:
        message.role === "assistant" &&
        "reasoning_content" in message &&
        typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : undefined,
      toolCallId:
        message.role === "tool" && "tool_call_id" in message
          ? typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : undefined
          : undefined,
      toolCalls:
        message.role === "assistant" &&
        "tool_calls" in message &&
        Array.isArray(message.tool_calls)
          ? message.tool_calls.map((toolCall) => ({
              id: toolCall.id,
              type: toolCall.type,
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              },
            }))
          : undefined,
    })),
    tools: request.tools?.map((tool) => ({
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    })),
    stream,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    thinkingEnabled: request.thinkingEnabled,
  };
}

export function mapRustProviderResponse(
  response: RustProviderResponse,
): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: response.message.content,
      reasoning_content: response.message.reasoningContent,
      tool_calls: response.message.toolCalls,
    },
    stopReason: response.stopReason,
    usage: response.usage,
  };
}

export function mapRustStreamResult(
  content: string,
  reasoningContent: string,
  toolCalls: AssistantMessage["tool_calls"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    reasoning_content: reasoningContent || undefined,
    tool_calls: toolCalls,
  };
}
