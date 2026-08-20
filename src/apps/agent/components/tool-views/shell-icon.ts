/**
 * Agent Window — shell badge marks (leaf, non-component).
 *
 * Which picture the shell badge shows for a family, and where it comes from.
 *
 * The badge used to carry a 5px tinted dot. A colour can only encode the
 * FAMILY, so bash and zsh wore the same green and you had to read the text to
 * tell them apart — the picture was decoration rather than information.
 *
 * The answer is the real brand mark, and this repo already ships two full icon
 * packs for the file explorer, so no new dependency was needed:
 *
 *   `public/material-icons/`  (material-icon-theme, 1,196 files)
 *   `public/vscode-icons/`    (@iconify-json/vscode-icons, 1,481 files)
 *
 * **The badge follows the pack the user already chose** for the explorer
 * (`useSettingsStore.explorerIconPack`). Picking one here would have meant the
 * transcript disagreeing with the file tree three feet away, and the setting
 * already exists.
 *
 * **Neither pack covers every shell**, which is why the fallback is not an
 * afterthought: Material has no bash mark and no cmd mark at all. A family with
 * no asset — and any asset that fails to load — falls back to the monochrome
 * silhouette in `AgentIcon` (`shell-posix` / `shell-pwsh` / `shell-cmd`). That
 * fallback is also what a CUSTOM icon pack gets, since a user-supplied pack
 * cannot be assumed to contain anything.
 */

import type { ShellMeta } from "@/apps/agent/components/tool-views/shell-meta";
import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";

/** The monochrome mark for a family. Always available — it is drawn, not loaded. */
export function shellFallbackIcon(family: ShellMeta["family"]): AgentIconName {
  switch (family) {
    case "powershell":
      return "shell-pwsh";
    case "cmd":
      return "shell-cmd";
    // An unrecognised shell id is still a shell, and the POSIX terminal is the
    // honest generic picture of one.
    default:
      return "shell-posix";
  }
}

/**
 * Brand marks per pack, by family.
 *
 * Deliberately a table rather than a name-guessing rule: both packs name their
 * files by FILE TYPE (`file-type-shell`, `console`), which is close enough to a
 * shell id to invite a `${pack}/${id}.svg` guess and wrong often enough that the
 * guess would 404 silently. Two packs times three families is small enough to
 * write down.
 */
const PACK_MARKS: Record<string, Partial<Record<ShellMeta["family"], string>>> = {
  material: {
    // Material has no bash and no cmd mark. `console.svg` is its generic
    // terminal, which is the right picture for the POSIX family; cmd gets the
    // silhouette rather than borrowing a mark that means something else.
    posix: "/material-icons/console.svg",
    powershell: "/material-icons/powershell.svg",
  },
  vscode: {
    posix: "/vscode-icons/file-type-shell.svg",
    powershell: "/vscode-icons/file-type-powershell.svg",
    cmd: "/vscode-icons/file-type-bat.svg",
  },
};

/**
 * The brand asset for this family under `packId`, or `null` when the pack has
 * none and the drawn silhouette should be used instead.
 */
export function shellBrandAsset(
  family: ShellMeta["family"],
  packId: string | null | undefined,
): string | null {
  if (!packId) return null;
  return PACK_MARKS[packId]?.[family] ?? null;
}
