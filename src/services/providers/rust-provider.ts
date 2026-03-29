import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { BaseProvider } from "./base-provider";
import type {
  RustProviderResponse,
  RustStreamChunk,
} from "./rust-contract";
import {
  buildRustProviderRequest,
  mapRustProviderResponse,
  mapRustStreamResult,
} from "./rust-message-mapper";
import { RustStreamState } from "./rust-stream-state";
import type {
  AssistantMessage,
  ChatRequest,
  ChatResponse,
  StreamCallbacks,
  TokenUsage,
  ProviderConfig,
} from "./types";

export class RustProvider extends BaseProvider {
  private currentRequestId: string | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  public override cancelRequest(): void {
    super.cancelRequest();

    if (this.currentRequestId) {
      invoke("cancel_aurora_provider_stream", {
        requestId: this.currentRequestId,
      }).catch(() => {
        // Stream may already be finished.
      });
      this.currentRequestId = null;
    }
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await invoke<RustProviderResponse>("aurora_provider_chat", {
      request: buildRustProviderRequest(this._config, request, false),
    });

    return mapRustProviderResponse(response);
  }

  public async streamChat(
    request: ChatRequest,
    callbacks: StreamCallbacks,
  ): Promise<AssistantMessage> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    this.currentRequestId = requestId;

    const streamState = new RustStreamState();
    let streamError: Error | null = null;

    try {
      callbacks.onStart?.();

      const unlistenChunk = await listen<RustStreamChunk>(
        `aurora-provider-chunk-${requestId}`,
        (event) => {
          streamState.applyChunk(event.payload, callbacks);
        },
      );

      const unlistenUsage = await listen<TokenUsage>(
        `aurora-provider-usage-${requestId}`,
        (event) => {
          callbacks.onUsage?.(event.payload);
        },
      );

      const unlistenError = await listen<string>(
        `aurora-provider-error-${requestId}`,
        (event) => {
          streamError = new Error(event.payload);
        },
      );

      await invoke("aurora_provider_stream", {
        requestId,
        request: buildRustProviderRequest(this._config, request, true),
      });

      unlistenChunk();
      unlistenUsage();
      unlistenError();

      if (streamError) {
        throw streamError;
      }

      const result = mapRustStreamResult(
        streamState.getContent(),
        streamState.getReasoningContent(),
        streamState.getToolCalls(),
      );

      callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.currentRequestId = null;
        throw new Error("Request cancelled");
      }

      if (typeof error === "object" && error !== null && "type" in error) {
        const tauriError = error as { msg?: string; type: string };
        if (tauriError.type === "cancelation") {
          this.currentRequestId = null;
          throw new Error("Request cancelled");
        }
      }

      const normalized =
        error instanceof Error ? error : new Error(String(error));
      callbacks.onError?.(normalized);
      throw normalized;
    } finally {
      this.currentRequestId = null;
    }
  }
}
