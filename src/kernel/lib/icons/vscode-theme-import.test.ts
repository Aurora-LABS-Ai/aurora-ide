import { describe, expect, it } from "vitest";

import { parseAuroraIconPackBundle } from "@/kernel/lib/icons/aurora-icon-pack";
import {
    convertVsCodeIconTheme,
    findIconThemePath,
    iconPackIdForExtension,
    type VsCodeIconTheme,
} from "@/kernel/lib/icons/vscode-theme-import";

const manifest = {
    id: "vscode-test-theme",
    name: "Test Theme",
    version: "1.0.0",
};

const svg = (fill: string) => `<svg viewBox="0 0 16 16"><rect fill="${fill}"/></svg>`;

/** A reader over an in-memory file table. */
const filesystem = (files: Record<string, string>) => (path: string) => files[path];

describe("convertVsCodeIconTheme", () => {
    const theme: VsCodeIconTheme = {
        iconDefinitions: {
            _file: { iconPath: "./icons/file.svg" },
            _folder: { iconPath: "./icons/folder.svg" },
            _folder_open: { iconPath: "./icons/folder-open.svg" },
            _ts: { iconPath: "./icons/typescript.svg" },
        },
        file: "_file",
        folder: "_folder",
        folderExpanded: "_folder_open",
        fileExtensions: { ts: "_ts" },
        fileNames: { "tsconfig.json": "_ts" },
        folderNames: { src: "_folder" },
        folderNamesExpanded: { src: "_folder_open" },
        languageIds: { typescript: "_ts" },
    };

    const files = {
        "./icons/file.svg": svg("#fff"),
        "./icons/folder.svg": svg("#888"),
        "./icons/folder-open.svg": svg("#999"),
        "./icons/typescript.svg": svg("#3178c6"),
    };

    it("carries every mapping across with its keys unchanged", () => {
        const { bundle, skipped, droppedMappings } = convertVsCodeIconTheme({
            theme,
            manifest,
            readIcon: filesystem(files),
        });

        expect(skipped).toEqual([]);
        expect(droppedMappings).toBe(0);
        expect(Object.keys(bundle.icons).sort()).toEqual([
            "_file",
            "_folder",
            "_folder_open",
            "_ts",
        ]);
        // Extension keys carry no leading dot in either format, so they pass
        // through as-is. Rewriting them would break every lookup.
        expect(bundle.mappings.fileExtensions).toEqual({ ts: "_ts" });
        expect(bundle.mappings.fileNames).toEqual({ "tsconfig.json": "_ts" });
        expect(bundle.mappings.folderNamesExpanded).toEqual({ src: "_folder_open" });
        expect(bundle.mappings.languageIds).toEqual({ typescript: "_ts" });
        expect(bundle.mappings.defaultFile).toBe("_file");
    });

    /// The bundle validator rejects the WHOLE pack if one mapping points at a
    /// missing icon. A theme with a single unreadable file would import as
    /// nothing at all, so unresolvable mappings have to go.
    it("drops a mapping whose icon could not be read rather than failing the theme", () => {
        const { bundle, skipped, droppedMappings } = convertVsCodeIconTheme({
            theme,
            manifest,
            readIcon: filesystem({ ...files, "./icons/typescript.svg": undefined as never }),
        });

        expect(skipped).toHaveLength(1);
        expect(skipped[0].key).toBe("_ts");
        // ts extension, tsconfig.json, and the typescript language id.
        expect(droppedMappings).toBe(3);
        expect(bundle.mappings.fileExtensions).toBeUndefined();
        expect(bundle.mappings.defaultFile).toBe("_file");

        // The point of dropping them: the result still loads.
        expect(() =>
            parseAuroraIconPackBundle(JSON.stringify(bundle)),
        ).not.toThrow();
    });

    /// Seti and VS Code's own default draw glyphs from a woff. Aurora has no
    /// glyph icon kind, so these must be reported, not silently missing.
    it("reports font-glyph definitions instead of dropping them silently", () => {
        const { skipped } = convertVsCodeIconTheme({
            theme: {
                iconDefinitions: {
                    _seti: { fontCharacter: "\\E001", fontColor: "#519aba", fontId: "seti" },
                },
                file: "_seti",
            },
            manifest,
            readIcon: () => undefined,
        });

        expect(skipped).toHaveLength(1);
        expect(skipped[0].reason).toContain("font glyph");
    });

    it("produces a bundle the real validator accepts", () => {
        const { bundle } = convertVsCodeIconTheme({
            theme,
            manifest,
            readIcon: filesystem(files),
        });

        const parsed = parseAuroraIconPackBundle(JSON.stringify(bundle));
        expect(parsed.manifest.name).toBe("Test Theme");
        // Raw SVG is normalised into a data URI on the way in.
        expect(parsed.icons._ts.startsWith("data:image/svg+xml")).toBe(true);
    });

    it("survives a theme with no mappings at all", () => {
        const { bundle, droppedMappings } = convertVsCodeIconTheme({
            theme: {},
            manifest,
            readIcon: () => undefined,
        });

        expect(droppedMappings).toBe(0);
        expect(bundle.icons).toEqual({});
        expect(bundle.mappings.fileExtensions).toBeUndefined();
    });
});

describe("findIconThemePath", () => {
    it("finds the contributed theme", () => {
        expect(
            findIconThemePath({
                contributes: { iconThemes: [{ id: "t", path: "./dist/theme.json" }] },
            }),
        ).toBe("./dist/theme.json");
    });

    /// VS Code itself defaults to the preferred entry, so a theme shipping a
    /// light and a dark variant lands on the one its author chose.
    it("prefers the entry the extension marks as preferred", () => {
        expect(
            findIconThemePath({
                contributes: {
                    iconThemes: [
                        { id: "light", path: "./light.json" },
                        { id: "dark", path: "./dark.json", _preferred: true },
                    ],
                },
            }),
        ).toBe("./dark.json");
    });

    /// A colour theme or a language pack dropped in by mistake. Saying so
    /// beats importing an empty pack that looks like it worked.
    it("returns null for an extension that contributes no icon theme", () => {
        expect(findIconThemePath({ contributes: { themes: [{ path: "./c.json" }] } })).toBeNull();
        expect(findIconThemePath({})).toBeNull();
        expect(findIconThemePath(null)).toBeNull();
    });
});

describe("iconPackIdForExtension", () => {
    /// Stable, so re-importing an updated copy replaces the pack instead of
    /// stacking a second near-identical card beside it.
    it("is derived from the extension identity, not chance", () => {
        expect(iconPackIdForExtension("PKief", "material-icon-theme")).toBe(
            "vscode-pkief-material-icon-theme",
        );
        expect(iconPackIdForExtension("PKief", "material-icon-theme")).toBe(
            iconPackIdForExtension("pkief", "Material Icon Theme"),
        );
    });

    it("copes with a missing publisher and with punctuation", () => {
        expect(iconPackIdForExtension(undefined, "Catppuccin — Icons!")).toBe(
            "vscode-catppuccin-icons",
        );
    });
});
