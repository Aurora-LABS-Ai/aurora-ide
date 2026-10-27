import { convertFileSrc } from "@tauri-apps/api/core";

export type AuroraRuntimeKind = "desktop" | "web";
export type AuroraUnlistenFn = () => void;

export interface AuroraEvent<T> {
  event: string;
  payload: T;
}

export type AuroraEventHandler<T> = (event: AuroraEvent<T>) => void;

export interface AuroraRuntime {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  isAvailable(): boolean;
  listen<T>(
    eventName: string,
    handler: AuroraEventHandler<T>,
  ): Promise<AuroraUnlistenFn>;
  readonly kind: AuroraRuntimeKind;
}

interface AuroraWebRuntimeConfig {
  apiBaseUrl?: string;
  token?: string;
}

interface AuroraWebInvokeSuccess<T> {
  data: T;
  ok: true;
}

interface AuroraWebInvokeFailure {
  error: string;
  ok: false;
}

type AuroraWebInvokeResponse<T> =
  | AuroraWebInvokeSuccess<T>
  | AuroraWebInvokeFailure;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAuroraWebInvokeResponse = <T>(
  value: unknown,
): value is AuroraWebInvokeResponse<T> =>
  isObjectRecord(value) && typeof value.ok === "boolean";

declare global {
  interface Window {
    __AURORA_WEB__?: AuroraWebRuntimeConfig;
    __TAURI__?: unknown;
  }
}

const WEB_TOKEN_STORAGE_KEY = "aurora-web-token";

const getWebApiBaseUrl = (): string => {
  const configuredBaseUrl =
    window.__AURORA_WEB__?.apiBaseUrl || import.meta.env.VITE_AURORA_WEB_API_URL;

  return (configuredBaseUrl || window.location.origin).replace(/\/$/, "");
};

const getWebAuthToken = (): string | null =>
  window.__AURORA_WEB__?.token ||
  window.localStorage.getItem(WEB_TOKEN_STORAGE_KEY);

class DesktopRuntime implements AuroraRuntime {
  public readonly kind = "desktop" as const;

  public isAvailable(): boolean {
    return isDesktopRuntime();
  }

  public async invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  public async listen<T>(
    eventName: string,
    handler: AuroraEventHandler<T>,
  ): Promise<AuroraUnlistenFn> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(eventName, (event) => {
      handler({ event: event.event, payload: event.payload });
    });
  }
}

class WebRuntime implements AuroraRuntime {
  public readonly kind = "web" as const;

  public isAvailable(): boolean {
    return typeof window !== "undefined" && typeof fetch === "function";
  }

  public async invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(
      `${this.apiBaseUrl()}/api/invoke/${encodeURIComponent(command)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ args: args ?? {} }),
      },
    );

    const payload = await this.readResponse<T>(response);
    if (isAuroraWebInvokeResponse<T>(payload)) {
      if (!payload.ok) {
        throw new Error(payload.error);
      }

      return payload.data;
    }

    if (!response.ok) {
      throw new Error(`Aurora web command failed: ${response.status}`);
    }

    return payload as T;
  }

  private apiBaseUrl(): string {
    return getWebApiBaseUrl();
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = getWebAuthToken();

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  private async readResponse<T>(
    response: Response,
  ): Promise<AuroraWebInvokeResponse<T> | T> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      if (response.ok) {
        return text as T;
      }
      return { ok: false, error: text || response.statusText };
    }

    return response.json() as Promise<AuroraWebInvokeResponse<T> | T>;
  }

  public async listen<T>(
    eventName: string,
    handler: AuroraEventHandler<T>,
  ): Promise<AuroraUnlistenFn> {
    return webEventHub(this.apiBaseUrl(), () => this.headers()).listen(
      eventName,
      handler as AuroraEventHandler<unknown>,
    );
  }
}

/**
 * One event stream per page, shared by every `listen`.
 *
 * A browser allows six HTTP/1.1 connections per host and the agent window
 * listens to dozens of event names, so one `EventSource` per name stalls the
 * page. The host (`src-tauri/src/web_host/events.rs`) opens one stream, names
 * it in its `ready` event, and forwards every event name the page subscribes
 * to as `{event, payload}`. When the stream reconnects it gets a new name, so
 * every name in use is subscribed again.
 */
class WebEventHub {
  private readonly handlers = new Map<string, Set<AuroraEventHandler<unknown>>>();
  private source: EventSource | null = null;
  private streamId: string | null = null;
  private readonly baseUrl: string;
  private readonly headers: () => HeadersInit;

  public constructor(baseUrl: string, headers: () => HeadersInit) {
    this.baseUrl = baseUrl;
    this.headers = headers;
  }

  public listen(
    eventName: string,
    handler: AuroraEventHandler<unknown>,
  ): AuroraUnlistenFn {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
      this.post("subscribe", eventName);
    }
    set.add(handler);
    this.open();

    return () => {
      const current = this.handlers.get(eventName);
      if (!current?.delete(handler) || current.size > 0) {
        return;
      }
      this.handlers.delete(eventName);
      this.post("unsubscribe", eventName);
    };
  }

  private open(): void {
    // No `EventSource` (a test DOM): handlers stay registered, nothing streams.
    if (this.source || typeof EventSource === "undefined") {
      return;
    }
    const source = new EventSource(`${this.baseUrl}/api/events/stream`);
    this.source = source;
    source.addEventListener("ready", (message) => {
      const ready = JSON.parse((message as MessageEvent<string>).data) as {
        stream?: string;
      };
      this.streamId = ready.stream ?? null;
      for (const name of this.handlers.keys()) {
        this.post("subscribe", name);
      }
    });
    source.onmessage = (message) => {
      const frame = JSON.parse(message.data) as { event?: string; payload?: unknown };
      if (typeof frame.event !== "string") {
        return;
      }
      for (const handler of this.handlers.get(frame.event) ?? []) {
        handler({ event: frame.event, payload: frame.payload });
      }
    };
    source.onerror = () => {
      // The browser reconnects by itself; the next `ready` re-subscribes.
      this.streamId = null;
      console.warn("[AuroraRuntime] Web event stream interrupted; reconnecting");
    };
  }

  private post(action: "subscribe" | "unsubscribe", eventName: string): void {
    if (!this.streamId) {
      return; // Sent on `ready` instead.
    }
    void fetch(`${this.baseUrl}/api/events/${action}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ stream: this.streamId, event: eventName }),
    }).catch((error: unknown) => {
      console.warn(`[AuroraRuntime] Could not ${action} ${eventName}`, error);
    });
  }
}

const webEventHubs = new Map<string, WebEventHub>();

const webEventHub = (baseUrl: string, headers: () => HeadersInit): WebEventHub => {
  let hub = webEventHubs.get(baseUrl);
  if (!hub) {
    hub = new WebEventHub(baseUrl, headers);
    webEventHubs.set(baseUrl, hub);
  }
  return hub;
};

let runtimeOverride: AuroraRuntime | null = null;

export const isDesktopRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI__" in window;

export const getAuroraRuntime = (): AuroraRuntime => {
  if (runtimeOverride) {
    return runtimeOverride;
  }

  return isDesktopRuntime() ? new DesktopRuntime() : new WebRuntime();
};

export const isAuroraRuntimeAvailable = (): boolean =>
  getAuroraRuntime().isAvailable();

export const auroraInvoke = async <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => getAuroraRuntime().invoke<T>(command, args);

/**
 * An address a page can load a file on the Aurora machine from (`<img src>`,
 * `<video src>`): Tauri's asset protocol in the desktop window, the web
 * host's `/api/file` route in a browser (`src-tauri/src/web_host/file.rs`).
 */
export const localFileUrl = (path: string): string =>
  isDesktopRuntime()
    ? convertFileSrc(path)
    : `${getWebApiBaseUrl()}/api/file?path=${encodeURIComponent(path)}`;

export const auroraListen = async <T>(
  eventName: string,
  handler: AuroraEventHandler<T>,
): Promise<AuroraUnlistenFn> => getAuroraRuntime().listen<T>(eventName, handler);

export const setAuroraRuntimeForTests = (runtime: AuroraRuntime | null): void => {
  runtimeOverride = runtime;
};
