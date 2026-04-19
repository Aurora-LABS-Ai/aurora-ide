import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DbThread,
  ThreadSummary as ServiceThreadSummary,
} from "../services/thread-service";

type MockDirectoryEntry = {
  extension: string | null;
  is_dir: boolean;
  is_file: boolean;
  name: string;
  path: string;
};

const {
  deletePathMock,
  isTauriMock,
  readDirectoryMock,
  readFileContentMock,
  writeFileContentMock,
  loadThreadMock,
  listThreadsMock,
  saveThreadMock,
  deleteThreadMock,
  initFromThreadMock,
  restoreFromThreadMock,
} = vi.hoisted(() => ({
  deletePathMock: vi.fn<(path: string) => Promise<void>>(async () => undefined),
  isTauriMock: vi.fn(() => true),
  readDirectoryMock: vi.fn<(path: string) => Promise<MockDirectoryEntry[]>>(
    async () => [],
  ),
  readFileContentMock: vi.fn<(path: string) => Promise<string>>(async () => ""),
  writeFileContentMock: vi.fn<(path: string, content: string) => Promise<void>>(
    async () => undefined,
  ),
  loadThreadMock: vi.fn<(threadId: string) => Promise<DbThread | null>>(
    async () => null,
  ),
  listThreadsMock: vi.fn<() => Promise<ServiceThreadSummary[]>>(async () => []),
  saveThreadMock: vi.fn(async () => undefined),
  deleteThreadMock: vi.fn(async () => undefined),
  initFromThreadMock: vi.fn(async () => undefined),
  restoreFromThreadMock: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  deletePath: deletePathMock,
  isTauri: isTauriMock,
  readDirectory: readDirectoryMock,
  readFileContent: readFileContentMock,
  writeFileContent: writeFileContentMock,
}));

vi.mock("../services/thread-service", () => ({
  threadService: {
    loadThread: loadThreadMock,
    listThreads: listThreadsMock,
    saveThread: saveThreadMock,
    deleteThread: deleteThreadMock,
  },
}));

vi.mock("./useContextStore", () => ({
  useContextStore: {
    getState: () => ({
      initFromThread: initFromThreadMock,
      restoreFromThread: restoreFromThreadMock,
    }),
  },
}));

import { fromServiceThreadSummary, useThreadStore } from "./useThreadStore";

describe("useThreadStore migration behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    useThreadStore.setState({
      currentThreadId: null,
      threads: {},
      threadList: [],
      isLoading: false,
    });
  });

  it("maps service thread summaries into local numeric timestamps", () => {
    const summary = fromServiceThreadSummary({
      id: "thread-1",
      title: "First thread",
      messageCount: 3,
      preview: "preview text",
      createdAt: "2026-03-27T10:00:00.000Z",
      updatedAt: "2026-03-27T11:00:00.000Z",
    });

    expect(summary).toEqual({
      id: "thread-1",
      title: "First thread",
      messageCount: 3,
      preview: "preview text",
      createdAt: Date.parse("2026-03-27T10:00:00.000Z"),
      updatedAt: Date.parse("2026-03-27T11:00:00.000Z"),
    });
  });

  it("loads a thread from the newer thread service before any dev-file fallback", async () => {
    loadThreadMock.mockResolvedValue({
      id: "db-thread",
      title: "Loaded from DB",
      summary: null,
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "hello",
          timestamp: "2026-03-27T12:00:00.000Z",
        },
      ],
      token_usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      },
      context_usage: {
        usedTokens: 14,
        contextWindow: 1000,
        percentage: 1.4,
      },
      created_at: "2026-03-27T12:00:00.000Z",
      updated_at: "2026-03-27T12:05:00.000Z",
    });

    const thread = await useThreadStore
      .getState()
      .loadThreadFromFile("db-thread");

    expect(loadThreadMock).toHaveBeenCalledWith("db-thread");
    expect(readFileContentMock).not.toHaveBeenCalled();
    expect(thread).not.toBeNull();
    expect(thread?.id).toBe("db-thread");
    expect(thread?.title).toBe("Loaded from DB");
    expect(thread?.messages[0]?.sender).toBe("user");
    expect(thread?.tokenUsage?.totalTokens).toBe(14);
    expect(thread?.contextUsage?.contextWindow).toBe(1000);
  });

  it("returns null in non-dev mode when the service cannot load a thread", async () => {
    loadThreadMock.mockResolvedValue(null);

    const thread = await useThreadStore
      .getState()
      .loadThreadFromFile("file-thread");

    expect(loadThreadMock).toHaveBeenCalledWith("file-thread");
    expect(readFileContentMock).not.toHaveBeenCalled();
    expect(thread).toBeNull();
  });

  it("rehydrates Rust context when loading a thread from the database", async () => {
    loadThreadMock.mockResolvedValue({
      id: "db-thread",
      title: "Loaded from DB",
      summary: null,
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "hello",
          timestamp: "2026-03-27T12:00:00.000Z",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "world",
          timestamp: "2026-03-27T12:01:00.000Z",
          thinking: "thinking",
          timeline: [
            {
              id: "thinking-1",
              type: "thinking",
              thinking: "thinking",
              timestamp: 1,
            },
            {
              id: "content-1",
              type: "content",
              content: "world",
              timestamp: 2,
            },
          ],
        },
      ],
      token_usage: null,
      context_usage: {
        usedTokens: 14,
        contextWindow: 1000,
        percentage: 1.4,
      },
      created_at: "2026-03-27T12:00:00.000Z",
      updated_at: "2026-03-27T12:05:00.000Z",
    });

    const thread = await useThreadStore.getState().loadThread("db-thread");

    expect(thread?.id).toBe("db-thread");
    expect(initFromThreadMock).toHaveBeenCalledWith(
      "db-thread",
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-1", sender: "user" }),
        expect.objectContaining({ id: "msg-2", sender: "assistant" }),
      ]),
    );
    expect(restoreFromThreadMock).toHaveBeenCalledWith({
      usedTokens: 14,
      contextWindow: 1000,
      percentage: 1.4,
    });
  });

  it("uses service summaries for thread history in non-dev mode", async () => {
    listThreadsMock.mockResolvedValue([
      {
        id: "db-1",
        title: "Database thread",
        messageCount: 2,
        preview: "db preview",
        createdAt: "2026-03-27T08:00:00.000Z",
        updatedAt: "2026-03-27T09:00:00.000Z",
      },
      {
        id: "db-2",
        title: "Another database thread",
        messageCount: 1,
        preview: "older preview",
        createdAt: "2026-03-27T06:00:00.000Z",
        updatedAt: "2026-03-27T07:00:00.000Z",
      },
    ]);

    await useThreadStore.getState().loadAllThreadsFromFiles();

    const state = useThreadStore.getState();

    expect(listThreadsMock).toHaveBeenCalledTimes(1);
    expect(readDirectoryMock).not.toHaveBeenCalled();
    expect(state.threadList.map((thread) => thread.id)).toEqual([
      "db-1",
      "db-2",
    ]);
    expect(
      state.threadList.find((thread) => thread.id === "db-1")?.preview,
    ).toBe("db preview");
    expect(
      state.threadList.find((thread) => thread.id === "db-2")?.preview,
    ).toBe("older preview");
    expect(state.threads["db-1"]).toBeUndefined();
    expect(state.threads["db-2"]).toBeUndefined();
    expect(state.isLoading).toBe(false);
  });
});
