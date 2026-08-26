import { describe, expect, it } from "vitest";

import { resolveRelative } from "@/apps/ide/features/theme/load-vscode-icon-theme";

describe("resolveRelative", () => {
    it("joins a plain relative path", () => {
        expect(resolveRelative("C:/ext/theme", "./icons/file.svg")).toBe(
            "C:/ext/theme/icons/file.svg",
        );
    });

    /// Themes that build into `dist/` reference their icons as `../icons/…`.
    /// Concatenating instead of resolving produces a path that does not exist,
    /// which then reads as a corrupt theme rather than a bad join.
    it("walks up for a parent-relative icon path", () => {
        expect(resolveRelative("C:/ext/dist", "../icons/file.svg")).toBe(
            "C:/ext/icons/file.svg",
        );
    });

    it("keeps the separator style the base used", () => {
        expect(resolveRelative("C:\\ext\\dist", "../icons/file.svg")).toBe(
            "C:\\ext\\icons\\file.svg",
        );
    });

    it("preserves a POSIX root", () => {
        expect(resolveRelative("/home/me/ext", "./icons/a.svg")).toBe(
            "/home/me/ext/icons/a.svg",
        );
    });

    it("ignores redundant current-directory segments", () => {
        expect(resolveRelative("C:/ext", "././icons/./a.svg")).toBe("C:/ext/icons/a.svg");
    });
});
