/**
 * Icon themes the user already has, from their other editors.
 *
 * Importing a theme used to mean finding one, downloading it, and converting
 * it by hand into a format only Aurora uses. Most people running an editor
 * like this already have several sitting in `~/.vscode/extensions` — so the
 * shortest path to a new icon set is not a download page, it is a list of what
 * is already on the machine.
 *
 * Lives beside the pack library rather than inside it: these are candidates,
 * not packs. A theme becomes a pack the moment it is added, and then it
 * appears in the library above with everything else.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Download, MonitorSmartphone, RefreshCw } from "lucide-react";

import { ActionButton, StatusPill } from "@/apps/ide/features/settings/settings-primitives";
import {
    settingsCardStyle,
    settingsDangerPanelStyle,
    settingsSubtlePanelStyle,
} from "@/apps/ide/features/settings/settings-shared";
import { loadVsCodeIconTheme } from "@/apps/ide/features/theme/load-vscode-icon-theme";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useIconPackStore } from "@/kernel/store/useIconPackStore";

interface InstalledIconTheme {
    id: string;
    name: string;
    publisher?: string;
    version: string;
    description?: string;
    extensionDir: string;
    source: string;
    /** False when the theme draws from a font, which Aurora cannot render. */
    renderable: boolean;
}

/** Per-row progress, so one slow add cannot make the whole list look busy. */
type RowState = { status: "adding" } | { status: "failed"; message: string };

export const InstalledIconThemes = () => {
    const customPacks = useIconPackStore((state) => state.customPacks);
    const importAuroraIconPack = useIconPackStore((state) => state.importAuroraIconPack);

    const [themes, setThemes] = useState<InstalledIconTheme[] | null>(null);
    const [scanError, setScanError] = useState<string | null>(null);
    const [rows, setRows] = useState<Record<string, RowState>>({});

    const scan = useCallback(async () => {
        setScanError(null);
        setThemes(null);
        try {
            setThemes(await auroraInvoke<InstalledIconTheme[]>("list_installed_icon_themes"));
        } catch (error) {
            setThemes([]);
            setScanError((error as Error).message);
        }
    }, []);

    useEffect(() => {
        void scan();
    }, [scan]);

    const add = async (theme: InstalledIconTheme) => {
        setRows((current) => ({ ...current, [theme.id]: { status: "adding" } }));
        try {
            const { bundle } = await loadVsCodeIconTheme(theme.extensionDir);
            await importAuroraIconPack(JSON.stringify(bundle));
            setRows((current) => {
                const next = { ...current };
                delete next[theme.id];
                return next;
            });
        } catch (error) {
            setRows((current) => ({
                ...current,
                [theme.id]: { status: "failed", message: (error as Error).message },
            }));
        }
    };

    // A theme is "added" when a pack carries its name. Ids differ by design —
    // the pack id is derived from publisher and name, the extension id from
    // the folder — so name is the honest comparison here.
    const addedNames = new Set(customPacks.map((pack) => pack.manifest.name.toLowerCase()));

    return (
        <div className="rounded-lg px-4 py-4" style={settingsCardStyle}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-sm font-semibold text-text-primary">From your editors</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                        Icon themes installed in VS Code, Cursor, VSCodium, or Windsurf. Adding one
                        copies its icons into Aurora, so it keeps working if you later remove the
                        extension.
                    </p>
                </div>
                <ActionButton
                    variant="secondary"
                    icon={<RefreshCw size={12} />}
                    onClick={() => void scan()}
                    disabled={themes === null}
                >
                    Rescan
                </ActionButton>
            </div>

            {scanError && (
                <div className="mt-3 rounded-lg p-3 text-xs" style={settingsDangerPanelStyle}>
                    {scanError}
                </div>
            )}

            {themes === null ? (
                <p className="mt-4 text-xs text-text-secondary">Looking for installed themes…</p>
            ) : themes.length === 0 ? (
                <div
                    className="mt-3 rounded-lg px-4 py-3 text-[11px] leading-relaxed text-text-secondary"
                    style={settingsSubtlePanelStyle}
                >
                    No icon themes found. Install one in VS Code or Cursor and rescan, or import an{" "}
                    <code>.aurora</code> pack above.
                </div>
            ) : (
                <ul className="mt-3 flex flex-col gap-2">
                    {themes.map((theme) => {
                        const row = rows[theme.id];
                        const added = addedNames.has(theme.name.toLowerCase());

                        return (
                            <li
                                key={theme.id}
                                className="rounded-lg px-3 py-2.5"
                                style={settingsSubtlePanelStyle}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-xs font-medium text-text-primary">
                                            {theme.name}
                                        </p>
                                        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
                                            <MonitorSmartphone size={11} aria-hidden="true" />
                                            <span className="truncate">
                                                {theme.source}
                                                {theme.publisher ? ` · ${theme.publisher}` : ""} · v
                                                {theme.version}
                                            </span>
                                        </p>
                                    </div>

                                    {!theme.renderable ? (
                                        <StatusPill variant="neutral" dot={false}>
                                            Font-based
                                        </StatusPill>
                                    ) : added ? (
                                        <StatusPill variant="success" dot={false}>
                                            <Check size={11} aria-hidden="true" /> Added
                                        </StatusPill>
                                    ) : (
                                        <ActionButton
                                            variant="primary"
                                            icon={<Download size={12} />}
                                            onClick={() => void add(theme)}
                                            disabled={row?.status === "adding"}
                                        >
                                            {row?.status === "adding" ? "Adding…" : "Add"}
                                        </ActionButton>
                                    )}
                                </div>

                                {!theme.renderable && (
                                    <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
                                        This theme draws its icons from a font. Aurora can only show
                                        themes built from image files.
                                    </p>
                                )}

                                {row?.status === "failed" && (
                                    <p className="mt-2 text-[11px] leading-relaxed text-danger">
                                        {row.message}
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};
