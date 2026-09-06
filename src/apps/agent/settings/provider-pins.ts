/**
 * Pinned providers — a client-side rail preference, exactly like the left
 * rail's pinned projects (`lib/workspace/project-order.ts`): providers are
 * store rows but "pinned in the settings rail" is a display preference of
 * this window, so it lives in localStorage rather than the provider record.
 */

export const PINNED_PROVIDERS_KEY = "agw-prov-pinned-providers";

export function loadPinnedProviders(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PINNED_PROVIDERS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function savePinnedProviders(ids: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PINNED_PROVIDERS_KEY, JSON.stringify(ids));
  } catch {
    // Storage full or blocked — the pin still applies for this session.
  }
}

/**
 * Which rail groups are open. Remembered so the sidebar reopens the way it
 * was left — a collapsed Built-in group that springs back open on every
 * visit makes the collapse pointless.
 */
export interface ProviderGroupsOpen {
  pinned: boolean;
  builtIn: boolean;
  custom: boolean;
  /** Picture-making providers. Aurora Chat only, so absent on the Build side. */
  images: boolean;
}

export const PROVIDER_GROUPS_OPEN_KEY = "agw-prov-groups-open";

const GROUPS_ALL_OPEN: ProviderGroupsOpen = {
  pinned: true,
  builtIn: true,
  custom: true,
  images: true,
};

export function loadProviderGroupsOpen(): ProviderGroupsOpen {
  if (typeof localStorage === "undefined") return { ...GROUPS_ALL_OPEN };
  try {
    const raw = localStorage.getItem(PROVIDER_GROUPS_OPEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return { ...GROUPS_ALL_OPEN };
    const record = parsed as Record<string, unknown>;
    return {
      pinned: record.pinned !== false,
      builtIn: record.builtIn !== false,
      custom: record.custom !== false,
      images: record.images !== false,
    };
  } catch {
    return { ...GROUPS_ALL_OPEN };
  }
}

export function saveProviderGroupsOpen(state: ProviderGroupsOpen): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PROVIDER_GROUPS_OPEN_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked — the fold still applies for this session.
  }
}
