import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auroraInvoke,
  auroraListen,
  getAuroraRuntime,
  isDesktopRuntime,
  setAuroraRuntimeForTests,
  type AuroraRuntime,
} from "@/kernel/lib/ipc/runtime";

const makeTestRuntime = (): AuroraRuntime => {
  const invokeMock = vi.fn(
    async (command: string, args?: Record<string, unknown>) => ({
      args,
      command,
    }),
  );

  return {
    kind: "desktop",
    isAvailable: () => true,
    invoke: invokeMock as unknown as AuroraRuntime["invoke"],
    listen: vi.fn(async () => () => undefined),
  };
};

describe("Aurora runtime", () => {
  beforeEach(() => {
    setAuroraRuntimeForTests(null);
    window.localStorage.clear();
    delete window.__AURORA_WEB__;
    delete window.__TAURI__;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setAuroraRuntimeForTests(null);
    vi.unstubAllGlobals();
  });

  it("uses an injected runtime for command forwarding", async () => {
    const runtime = makeTestRuntime();
    setAuroraRuntimeForTests(runtime);

    await expect(
      auroraInvoke("read_file_content", { path: "src/main.ts" }),
    ).resolves.toEqual({
      command: "read_file_content",
      args: { path: "src/main.ts" },
    });
    expect(runtime.invoke).toHaveBeenCalledWith("read_file_content", {
      path: "src/main.ts",
    });
  });

  it("shares one web event stream across every listen and resubscribes after a reconnect", async () => {
    window.__AURORA_WEB__ = { apiBaseUrl: "http://127.0.0.1:4801", token: "t" };
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      public onmessage: ((message: MessageEvent<string>) => void) | null = null;
      public onerror: (() => void) | null = null;
      private readonly ready: ((message: MessageEvent<string>) => void)[] = [];
      public readonly url: string;
      public constructor(url: string) {
        this.url = url;
        sources.push(this);
      }
      public addEventListener(_name: "ready", handler: (message: MessageEvent<string>) => void) {
        this.ready.push(handler);
      }
      public sendReady(stream: string) {
        for (const handler of this.ready) {
          handler(new MessageEvent("ready", { data: JSON.stringify({ stream }) }));
        }
      }
      public send(frame: unknown) {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
    }
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);
    const subscribed = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/api/events/subscribe"))
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);

    const turns: unknown[] = [];
    const tools: unknown[] = [];
    await auroraListen("agent_event", (event) => turns.push(event.payload));
    const stopTools = await auroraListen("agent_tool_pending", (event) => tools.push(event.payload));

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("http://127.0.0.1:4801/api/events/stream");
    // Nothing is posted before the stream has a name.
    expect(subscribed()).toEqual([]);

    sources[0].sendReady("s1");
    expect(subscribed()).toEqual([
      { stream: "s1", event: "agent_event" },
      { stream: "s1", event: "agent_tool_pending" },
    ]);

    sources[0].send({ event: "agent_event", payload: { delta: "hi" } });
    sources[0].send({ event: "agent_tool_pending", payload: { id: 1 } });
    expect(turns).toEqual([{ delta: "hi" }]);
    expect(tools).toEqual([{ id: 1 }]);

    stopTools();
    sources[0].onerror?.();
    sources[0].sendReady("s2");
    // Only the name still in use is subscribed on the new stream.
    expect(subscribed().slice(-1)).toEqual([{ stream: "s2", event: "agent_event" }]);
  });

  it("detects the desktop runtime from the Tauri global", () => {
    window.__TAURI__ = {};

    expect(isDesktopRuntime()).toBe(true);
    expect(getAuroraRuntime().kind).toBe("desktop");
  });

  it("posts web-mode commands to the Aurora web invoke endpoint", async () => {
    window.__AURORA_WEB__ = {
      apiBaseUrl: "http://127.0.0.1:3721",
      token: "session-token",
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { content: "hello" } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await auroraInvoke<{ content: string }>("read_file_content", {
      path: "/repo/file.ts",
    });

    expect(result).toEqual({ content: "hello" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3721/api/invoke/read_file_content",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer session-token",
        },
        body: JSON.stringify({ args: { path: "/repo/file.ts" } }),
      }),
    );
  });

  it("throws web-mode command errors with the backend message", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "command denied" }), {
        headers: { "content-type": "application/json" },
        status: 403,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(auroraInvoke("write_file_content")).rejects.toThrow(
      "command denied",
    );
  });
});
