import { describe, expect, it } from "vitest";

import { buildContextTurnsFromMessages } from "./context-rehydration";
import type { Message } from "../types";

describe("buildContextTurnsFromMessages", () => {
  it("reconstructs a turn with thinking, tool calls, and tool results", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        sender: "user",
        content: "Inspect the repo",
        timestamp: 1713520000000,
      },
      {
        id: "assistant-1",
        sender: "assistant",
        content: "",
        thinking: "initial thought",
        timestamp: 1713520001000,
        timeline: [
          {
            id: "thinking-1",
            type: "thinking",
            thinking: "initial thought",
            timestamp: 1713520001000,
          },
          {
            id: "content-1",
            type: "content",
            content: "I checked the files.",
            timestamp: 1713520002000,
          },
          {
            id: "tool-1",
            type: "tool",
            timestamp: 1713520003000,
            tool: {
              id: "call-1",
              name: "file_read",
              status: "complete",
              args: { path: "src/main.ts" },
              result: "file contents",
            },
          },
          {
            id: "tool-2",
            type: "tool",
            timestamp: 1713520004000,
            tool: {
              id: "call-2",
              name: "shell_execute",
              status: "failed",
              args: {},
              rawArgs: "{\"command\":\"pnpm test\"}",
              error: "Command failed",
            },
          },
        ],
      },
    ];

    const turns = buildContextTurnsFromMessages("thread-1", messages);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "user-1",
      threadId: "thread-1",
      userMessage: "Inspect the repo",
      turnIndex: 0,
    });
    expect(turns[0]?.rounds).toHaveLength(1);
    expect(turns[0]?.rounds[0]).toMatchObject({
      response: "I checked the files.",
      thinking: "initial thought",
      roundIndex: 0,
    });
    expect(turns[0]?.rounds[0]?.toolCalls).toEqual([
      {
        id: "call-1",
        name: "file_read",
        arguments: "{\"path\":\"src/main.ts\"}",
      },
      {
        id: "call-2",
        name: "shell_execute",
        arguments: "{\"command\":\"pnpm test\"}",
      },
    ]);
    expect(turns[0]?.rounds[0]?.toolResults["call-1"]).toMatchObject({
      toolCallId: "call-1",
      content: "file contents",
      isError: false,
    });
    expect(turns[0]?.rounds[0]?.toolResults["call-2"]).toMatchObject({
      toolCallId: "call-2",
      content: "Command failed",
      isError: true,
    });
  });

  it("preserves a trailing unanswered user turn", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        sender: "user",
        content: "Need help",
        timestamp: 1713520000000,
      },
    ];

    const turns = buildContextTurnsFromMessages("thread-2", messages);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "user-1",
      userMessage: "Need help",
      rounds: [],
    });
  });
});
