/**
 * Turn a VS Code icon theme into an Aurora icon pack.
 *
 * The two formats line up almost field for field — `fileExtensions`,
 * `fileNames`, `folderNames`, `folderNamesExpanded` and `languageIds` carry the
 * same meaning and the same key spelling (extensions with no leading dot,
 * names lowercased). The only real difference is indirection: VS Code points a
 * mapping at a key in `iconDefinitions`, which points at a file on disk, while
 * an Aurora pack is one self-contained JSON with the images inlined. So this is
 * a reader, not a translation.
 *
 * Deliberately pure: reading files is the caller's job, handed in as
 * `readIcon`. That keeps every conversion rule testable without a filesystem,
 * and it is the part most likely to be wrong.
 *
 * **Not supported: font-based themes.** Seti — VS Code's own default — draws
 * from a woff and gives each definition a `fontCharacter` instead of an
 * `iconPath`. Aurora's `ResolvedExplorerIcon` has no glyph kind, so those
 * definitions are reported in `skipped` rather than silently dropped.
 */

import type { AuroraIconPackBundle } from "@/kernel/lib/icons/aurora-icon-pack";

/** One entry of a theme's `iconDefinitions`. */
export interface VsCodeIconDefinition {
    iconPath?: string;
    fontCharacter?: string;
    fontColor?: string;
    fontId?: string;
}

/** The shape this reader consumes. Unknown fields are ignored, not rejected. */
export interface VsCodeIconTheme {
    iconDefinitions?: Record<string, VsCodeIconDefinition>;
    file?: string;
    folder?: string;
    folderExpanded?: string;
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    folderNames?: Record<string, string>;
    folderNamesExpanded?: Record<string, string>;
    languageIds?: Record<string, string>;
}

/** Why one icon definition did not make it across. */
export interface SkippedIcon {
    key: string;
    reason: string;
}

export interface VsCodeThemeConversion {
    bundle: AuroraIconPackBundle;
    /** Definitions that could not be carried over. */
    skipped: SkippedIcon[];
    /**
     * Mappings dropped because the icon they pointed at was skipped.
     *
     * They cannot be kept: `parseAuroraIconPackBundle` rejects the WHOLE bundle
     * if any mapping references an icon that is not in `icons`. Dropping the
     * mapping costs one file type its icon; keeping it costs the user the
     * entire theme.
     */
    droppedMappings: number;
}

export interface ConvertOptions {
    theme: VsCodeIconTheme;
    manifest: {
        id: string;
        name: string;
        version: string;
        author?: string;
        description?: string;
    };
    /**
     * Read one icon named by an `iconPath`, exactly as the theme spelled it —
     * resolving it against the theme file's own folder is the caller's job,
     * because only the caller knows where that folder is.
     *
     * Return raw SVG text or a `data:` URI. Return `undefined` for a file that
     * is missing or of a kind you do not want to carry.
     */
    readIcon: (iconPath: string) => string | undefined;
}

/** A map of `name → iconKey`, keeping only entries whose icon survived. */
const keepResolvable = (
    source: Record<string, string> | undefined,
    available: Set<string>,
    onDrop: () => void,
): Record<string, string> | undefined => {
    if (!source) return undefined;
    const kept: Record<string, string> = {};
    for (const [name, iconKey] of Object.entries(source)) {
        if (typeof iconKey !== "string" || !available.has(iconKey)) {
            onDrop();
            continue;
        }
        kept[name] = iconKey;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
};

export const convertVsCodeIconTheme = (
    options: ConvertOptions,
): VsCodeThemeConversion => {
    const { theme, manifest, readIcon } = options;
    const definitions = theme.iconDefinitions ?? {};
    const icons: Record<string, string> = {};
    const skipped: SkippedIcon[] = [];

    for (const [key, definition] of Object.entries(definitions)) {
        if (!definition || typeof definition !== "object") {
            skipped.push({ key, reason: "the definition is not an object" });
            continue;
        }
        if (!definition.iconPath) {
            skipped.push({
                key,
                reason: definition.fontCharacter
                    ? "it draws a font glyph, which Aurora cannot render yet"
                    : "it names no icon file",
            });
            continue;
        }
        const content = readIcon(definition.iconPath);
        if (!content || !content.trim()) {
            skipped.push({ key, reason: `${definition.iconPath} could not be read` });
            continue;
        }
        icons[key] = content.trim();
    }

    const available = new Set(Object.keys(icons));
    let droppedMappings = 0;
    const drop = () => {
        droppedMappings += 1;
    };

    const keepDefault = (iconKey: string | undefined): string | undefined => {
        if (!iconKey) return undefined;
        if (!available.has(iconKey)) {
            drop();
            return undefined;
        }
        return iconKey;
    };

    return {
        bundle: {
            format: "aurora-pack",
            schemaVersion: 1,
            packageType: "icon-pack",
            manifest,
            icons,
            mappings: {
                defaultFile: keepDefault(theme.file),
                defaultFolder: keepDefault(theme.folder),
                defaultFolderExpanded: keepDefault(theme.folderExpanded),
                fileExtensions: keepResolvable(theme.fileExtensions, available, drop),
                fileNames: keepResolvable(theme.fileNames, available, drop),
                folderNames: keepResolvable(theme.folderNames, available, drop),
                folderNamesExpanded: keepResolvable(
                    theme.folderNamesExpanded,
                    available,
                    drop,
                ),
                languageIds: keepResolvable(theme.languageIds, available, drop),
            },
        },
        skipped,
        droppedMappings,
    };
};

/**
 * The theme file a VS Code extension contributes, as a path relative to the
 * extension folder.
 *
 * An extension may contribute several; `preferred` picks the one flagged as
 * such, which is what VS Code itself defaults to. Returns `null` when the
 * extension contributes no icon theme at all — the honest answer for a colour
 * theme or a language pack someone dropped in by mistake.
 */
export const findIconThemePath = (packageJson: unknown): string | null => {
    if (!packageJson || typeof packageJson !== "object") return null;
    const contributes = (packageJson as { contributes?: unknown }).contributes;
    if (!contributes || typeof contributes !== "object") return null;
    const themes = (contributes as { iconThemes?: unknown }).iconThemes;
    if (!Array.isArray(themes) || themes.length === 0) return null;

    const withPath = themes.filter(
        (entry): entry is { path: string; _preferred?: boolean } =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as { path?: unknown }).path === "string",
    );
    if (withPath.length === 0) return null;

    const preferred = withPath.find((entry) => entry._preferred === true);
    return (preferred ?? withPath[0]).path;
};

/**
 * A stable pack id for an imported theme.
 *
 * Derived from the extension's own identity rather than randomly, so
 * re-importing an updated copy replaces the pack instead of stacking a second
 * near-identical card next to it.
 */
export const iconPackIdForExtension = (
    publisher: string | undefined,
    name: string,
): string => {
    const slug = (value: string) =>
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    const base = publisher ? `${slug(publisher)}-${slug(name)}` : slug(name);
    return `vscode-${base || "imported-theme"}`;
};
