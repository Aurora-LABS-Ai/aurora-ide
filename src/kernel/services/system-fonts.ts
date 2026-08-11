/**
 * System fonts — frontend access to the cached installed-font list.
 *
 * The heavy lifting (DirectWrite enumeration + SQLite cache) lives in the
 * Rust `system_font_families` command; this wrapper adds a per-window memo so
 * a settings page that mounts the picker twice doesn't round-trip the IPC
 * twice. `refresh: true` bypasses both layers — that is the "Rescan" button.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/kernel/lib/ipc/tauri";

let memo: string[] | null = null;
let inflight: Promise<string[]> | null = null;

export async function listSystemFontFamilies(refresh = false): Promise<string[]> {
  if (!isTauri()) return [];
  if (!refresh) {
    if (memo) return memo;
    if (inflight) return inflight;
  }
  inflight = invoke<string[]>("system_font_families", { refresh })
    .then((families) => {
      memo = Array.isArray(families) ? families : [];
      return memo;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
