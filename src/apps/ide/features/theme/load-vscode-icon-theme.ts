/**
 * Read a downloaded VS Code icon theme off disk and hand back an Aurora pack.
 *
 * The conversion rules live in `kernel/lib/icons/vscode-theme-import` and are
 * pure. This file is the half that touches the filesystem: find the theme
 * inside the extension, resolve every `iconPath` against the theme file's own
 * folder, and pull the images in one batch rather than 1,500 round trips.
 *
 * What "a downloaded theme" means in practice: a folder holding the
 * extension's `package.json` — either an unpacked `.vsix`, a clone of the
 * theme's repository, or a folder under `~/.vscode/extensions`. A `.vsix` file
 * itself is a zip and is NOT handled here; unpacking one needs a zip reader
 * the Rust side does not carry.
 */

import { readFileContent } from "@/kernel/lib/ipc/tauri";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { AuroraIconPackBundle } from "@/kernel/lib/icons/aurora-icon-pack";
import {
    convertVsCodeIconTheme,
    findIconThemePath,
    iconPackIdForExtension,
    type SkippedIcon,
    type VsCodeIconTheme,
} from "@/kernel/lib/icons/vscode-theme-import";

export interface LoadedIconTheme {
    bundle: AuroraIconPackBundle;
    /** Icons that could not be carried over, worth surfacing to the user. */
    skipped: SkippedIcon[];
    /** Mappings dropped because their icon was skipped. */
    droppedMappings: number;
    /** How many icons made it. Zero means the import is not worth applying. */
    iconCount: number;
}

/** Split a path on either separator, since a Windows theme mixes both. */
const parts = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

/**
 * Resolve `relative` against `base`, honouring `.` and `..`.
 *
 * Theme files reference icons as `./icons/file.svg` and, in themes whose JSON
 * sits in a `dist/` folder, as `../icons/file.svg`. Naive concatenation turns
 * the second into a path that does not exist, which reads as a corrupt theme
 * rather than a bad join.
 */
export const resolveRelative = (base: string, relative: string): string => {
    const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
    const stack = parts(base);
    // A leading `/` or a drive letter must survive the rejoin.
    const prefix = base.startsWith("/") ? "/" : "";
    for (const segment of parts(relative)) {
        if (segment === ".") continue;
        if (segment === "..") {
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return prefix + stack.join(separator);
};

/** Extension folder → a pack ready to import, or a thrown reason why not. */
export const loadVsCodeIconTheme = async (
    extensionDir: string,
): Promise<LoadedIconTheme> => {
    const packageJsonPath = resolveRelative(extensionDir, "package.json");

    let packageJson: unknown;
    try {
        packageJson = JSON.parse(await readFileContent(packageJsonPath));
    } catch {
        throw new Error(
            "This folder has no readable package.json, so it is not a VS Code extension. " +
                "Point Aurora at the folder that contains the extension's package.json.",
        );
    }

    const themeRelativePath = findIconThemePath(packageJson);
    if (!themeRelativePath) {
        const name =
            (packageJson as { displayName?: string; name?: string }).displayName ??
            (packageJson as { name?: string }).name ??
            "This extension";
        throw new Error(
            `${name} does not contribute a file icon theme. Colour themes and language ` +
                "packs cannot be imported here — look for an extension described as an icon theme.",
        );
    }

    const themePath = resolveRelative(extensionDir, themeRelativePath);
    let theme: VsCodeIconTheme;
    try {
        theme = JSON.parse(await readFileContent(themePath)) as VsCodeIconTheme;
    } catch {
        throw new Error(
            `The extension points at ${themeRelativePath}, but that file could not be read.`,
        );
    }

    // Read through the Rust side rather than the generic file reader, which
    // decodes UTF-8: a PNG would arrive as mojibake. That is not a corner
    // case — VSCode Great Icons is 298 PNGs and no SVG at all, so an
    // SVG-only reader imports it as an empty pack. Rust returns SVG as markup
    // and raster formats as base64 data URIs, and resolves each `iconPath`
    // against the THEME file's folder (themes built into `dist/` reference
    // `../icons/…`) while refusing anything outside the extension.
    const wanted = [
        ...new Set(
            Object.values(theme.iconDefinitions ?? {})
                .map((definition) => definition?.iconPath)
                .filter((iconPath): iconPath is string => Boolean(iconPath)),
        ),
    ];

    const assets = await auroraInvoke<Record<string, string>>(
        "read_icon_theme_assets",
        { extensionDir, themePath, iconPaths: wanted },
    );
    const contents = new Map(Object.entries(assets ?? {}));

    const { bundle, skipped, droppedMappings } = convertVsCodeIconTheme({
        theme,
        manifest: {
            id: iconPackIdForExtension(
                (packageJson as { publisher?: string }).publisher,
                (packageJson as { name?: string }).name ?? "imported-theme",
            ),
            name:
                (packageJson as { displayName?: string }).displayName ??
                (packageJson as { name?: string }).name ??
                "Imported icon theme",
            version: (packageJson as { version?: string }).version ?? "0.0.0",
            author:
                (packageJson as { publisher?: string }).publisher ??
                (packageJson as { author?: string }).author,
            description: (packageJson as { description?: string }).description,
        },
        readIcon: (iconPath) => contents.get(iconPath),
    });

    const iconCount = Object.keys(bundle.icons).length;
    if (iconCount === 0) {
        const glyphs = skipped.filter((entry) => entry.reason.includes("font glyph")).length;
        throw new Error(
            glyphs > 0
                ? "This theme draws its icons from a font, which Aurora cannot render yet. " +
                  "Themes built from SVG files import fine."
                : "No icons could be read from this theme.",
        );
    }

    return { bundle, skipped, droppedMappings, iconCount };
};
