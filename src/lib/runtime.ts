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
    const url = new URL(
      `${this.apiBaseUrl()}/api/events/${encodeURIComponent(eventName)}`,
    );
    const token = getWebAuthToken();
    if (token) {
      url.searchParams.set("token", token);
    }

    const eventSource = new EventSource(url.toString());
    eventSource.onmessage = (message) => {
      const payload = JSON.parse(message.data) as T | { payload: T };
      handler({
        event: eventName,
        payload:
          isObjectRecord(payload) && "payload" in payload
            ? (payload.payload as T)
            : (payload as T),
      });
    };
    eventSource.onerror = () => {
      console.warn(`[AuroraRuntime] Web event stream failed: ${eventName}`);
    };

    return () => {
      eventSource.close();
    };
  }
}

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

export const auroraListen = async <T>(
  eventName: string,
  handler: AuroraEventHandler<T>,
): Promise<AuroraUnlistenFn> => getAuroraRuntime().listen<T>(eventName, handler);

export const setAuroraRuntimeForTests = (runtime: AuroraRuntime | null): void => {
  runtimeOverride = runtime;
};
