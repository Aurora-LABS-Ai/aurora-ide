/**
 * Thread Converter - Converts UI thread messages to API message format
 * Enables conversation continuity when resuming threads
 * 
 * UI Message Format (from types/index.ts):
 *   - id, sender ('user'|'assistant'), content, timestamp, timeline[]
 *   - timeline contains: thinking events, tool events, content events
 * 
 * API Message Format (from providers/types.ts):
 *   - role ('user'|'assistant'|'tool'), content, tool_calls?, reasoning_content?
 */

import type { Message as UIMessage, TimelineEvent } from '../types';
import type { Message as ApiMessage, ToolCallRequest, ToolMessage, AssistantMessage } from './providers/types';

/**
 * Convert UI thread messages to API conversation history format
 * This enables the agent to have context when resuming a thread
 */
export function convertThreadToApiHistory(uiMessages: UIMessage[]): ApiMessage[] {
    const apiMessages: ApiMessage[] = [];

    for (const msg of uiMessages) {
        if (msg.sender === 'user') {
            // User messages are straightforward
            apiMessages.push({
                role: 'user',
                content: msg.content,
            });
        } else if (msg.sender === 'assistant') {
            // Assistant messages need to be reconstructed from timeline events
            const { content, reasoning, toolCalls, toolResults } = extractFromTimeline(msg.timeline || []);

            // Only add if there's actual content or tool calls
            if (content || toolCalls.length > 0 || reasoning) {
                const assistantMsg: AssistantMessage = {
                    role: 'assistant',
                    content: content || '',
                };

                if (reasoning) {
                    assistantMsg.reasoning_content = reasoning;
                }

                if (toolCalls.length > 0) {
                    assistantMsg.tool_calls = toolCalls;
                }

                apiMessages.push(assistantMsg);

                // Add tool results as separate tool messages
                for (const result of toolResults) {
                    const toolMsg: ToolMessage = {
                        role: 'tool',
                        tool_call_id: result.id,
                        content: result.result,
                    };
                    apiMessages.push(toolMsg);
                }
            }
        }
    }

    return apiMessages;
}

/**
 * Extract content, reasoning, tool calls, and tool results from timeline events
 */
function extractFromTimeline(timeline: TimelineEvent[]): {
    content: string;
    reasoning: string;
    toolCalls: ToolCallRequest[];
    toolResults: ToolResult[];
} {
    let content = '';
    let reasoning = '';
    const toolCalls: ToolCallRequest[] = [];
    const toolResults: ToolResult[] = [];

    for (const event of timeline) {
        switch (event.type) {
            case 'content':
                if (event.content) {
                    content += event.content;
                }
                break;

            case 'thinking':
                if (event.thinking) {
                    reasoning += event.thinking;
                }
                break;

            case 'tool':
                if (event.tool) {
                    // Add tool call request
                    toolCalls.push({
                        id: event.tool.id,
                        type: 'function',
                        function: {
                            name: event.tool.name,
                            arguments: JSON.stringify(event.tool.args || {}),
                        },
                    });

                    // Add tool result if completed
                    if (event.tool.status === 'complete' && event.tool.result !== undefined) {
                        toolResults.push({
                            id: event.tool.id,
                            result: event.tool.result,
                        });
                    } else if (event.tool.status === 'failed' && event.tool.error) {
                        toolResults.push({
                            id: event.tool.id,
                            result: JSON.stringify({ error: event.tool.error }),
                        });
                    } else if (event.tool.status === 'rejected') {
                        toolResults.push({
                            id: event.tool.id,
                            result: JSON.stringify({ error: 'Tool execution rejected by user' }),
                        });
                    }
                }
                break;
        }
    }

    return { content, reasoning, toolCalls, toolResults };
}

interface ToolResult {
    id: string;
    result: string;
}

/**
 * Get the number of valid conversation turns (for logging/debugging)
 */
export function countValidTurns(apiMessages: ApiMessage[]): {
    userMessages: number;
    assistantMessages: number;
    toolMessages: number;
} {
    let userMessages = 0;
    let assistantMessages = 0;
    let toolMessages = 0;

    for (const msg of apiMessages) {
        switch (msg.role) {
            case 'user':
                userMessages++;
                break;
            case 'assistant':
                assistantMessages++;
                break;
            case 'tool':
                toolMessages++;
                break;
        }
    }

    return { userMessages, assistantMessages, toolMessages };
}
