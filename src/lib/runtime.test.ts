import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auroraInvoke,
  getAuroraRuntime,
  isDesktopRuntime,
  setAuroraRuntimeForTests,
  type AuroraRuntime,
} from "./runtime";

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
