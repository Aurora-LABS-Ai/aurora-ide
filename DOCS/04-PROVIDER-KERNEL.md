# Provider Kernel Blueprint

## Purpose

Aurora should own its provider contract instead of letting any SDK or wire format define app behavior.

This document defines the target architecture for a bulletproof provider layer that supports:

- OpenAI-compatible providers
- Anthropic-compatible providers
- local providers like LM Studio and Ollama
- custom providers with odd compatibility edges
- tool calling
- reasoning streams
- cancellation
- future backend adapters without frontend rewrites

## Design Rule

Aurora owns the canonical model.

Providers are adapters.

SDKs are optional implementation details.

## Current Problem

Right now provider behavior is spread across:

- TypeScript request builders
- TypeScript stream parsers
- Rust proxy commands
- Rust local-provider normalization
- settings-driven branching

That makes migration risky because transport, message shape, and provider quirks are coupled together.

## Target Shape

Split the provider stack into four layers.

### 1. Aurora Contract Layer

Aurora-owned types that never depend on vendor SDKs:

- `AuroraProviderConfig`
- `AuroraMessage`
- `AuroraAssistantMessage`
- `AuroraToolDefinition`
- `AuroraToolCall`
- `AuroraToolResult`
- `AuroraUsage`
- `AuroraStreamEvent`
- `AuroraProviderCapabilities`

This layer should match what `AgentService` already needs, not what a provider SDK happens to expose.

### 2. Message Mapping Layer

Aurora-owned request and response mappers:

- Aurora -> OpenAI-compatible
- Aurora -> Anthropic-compatible
- OpenAI-compatible -> Aurora
- Anthropic-compatible -> Aurora

This layer owns:

- assistant `tool_calls`
- `tool_call_id`
- `reasoning_content`
- Anthropic `tool_use`
- Anthropic `tool_result`
- empty/null assistant content edge cases
- local reasoning field aliases

### 3. Transport Layer

A minimal runtime interface:

- `send_chat`
- `stream_chat`
- `cancel_stream`

This layer does not know about UI.

It only knows:

- URL construction
- headers
- body
- retries and timeouts
- streaming bytes or SDK chunks

### 4. Event Normalization Layer

Everything emitted to the frontend should be normalized before it leaves the backend:

- `token`
- `reasoning`
- `tool_call_delta`
- `usage`
- `error`
- `done`

The frontend should not care whether a provider used SSE, JSON lines, SDK streams, or custom event blocks.

## Canonical Capabilities

Do not branch on provider name unless unavoidable.

Branch on capabilities:

- `uses_openai_tool_messages`
- `uses_anthropic_content_blocks`
- `supports_reasoning_stream`
- `supports_usage_in_stream`
- `supports_tool_call_stream`
- `supports_custom_headers`
- `supports_custom_body_params`
- `supports_local_reasoning_aliases`
- `requires_api_key`

That gives Aurora one policy model even when provider names change.

## Local Providers Are First-Class

LM Studio and Ollama should not be treated as generic custom providers.

They need their own compatibility guarantees because Aurora already depends on:

- local model discovery
- API-key optional flows
- toggled thinking support
- varying reasoning field names
- streaming quirks

Keep them inside the provider kernel as first-class adapters.

## Frontend Contract Rules

`AgentService` should continue to rely on one stable interface:

- `streamChat(request, callbacks)`
- `chat(request)`
- `cancelRequest()`

The provider kernel can move to Rust internally, but those semantics should stay stable until a later intentional redesign.

## Rollout Strategy

### Step 1

Freeze the Aurora contract in code and docs before changing transport.

### Step 2

Move transport behind a backend adapter while keeping current frontend provider semantics.

### Step 3

Migrate one provider at a time behind feature routing.

### Step 4

Delete old provider implementations only after transcript-level parity tests pass.

## Required Tests

### Message-shape fixtures

Golden fixtures for:

- assistant text only
- assistant reasoning plus text
- assistant tool call
- tool result follow-up
- Anthropic tool blocks
- LM Studio reasoning alias handling

### Transcript tests

Full turn sequences:

1. user -> assistant tool call
2. tool result -> assistant follow-up
3. long thread -> summarization path
4. cancel during stream

### Settings tests

Verify that these fields still affect runtime behavior:

- `providerType`
- `customHeaders`
- `customParams`
- `defaultTemperature`
- `defaultMaxTokens`
- `supportsThinking`
- `supportsToolStream`
- `requiresApiKey`

## Permanent Fallback Rule

Aurora should keep a raw transport fallback path for providers that do not fit a higher-level adapter cleanly.

This is especially important for:

- `custom`
- LM Studio
- Ollama
- future self-hosted or partially compatible endpoints

## Success Condition

The provider kernel is successful when:

- the frontend does not care which backend adapter is used
- transcripts remain stable across providers
- cancellation works reliably
- tool-call chains survive round trips
- local providers remain first-class
- adding a new provider means writing an adapter, not editing app-wide logic

## Non-Goal

The goal is not to eliminate every provider-specific file.

The goal is to isolate provider-specific code so it stops leaking into the rest of Aurora.
