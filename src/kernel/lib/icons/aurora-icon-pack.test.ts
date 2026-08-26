import { describe, expect, it } from "vitest";

import { parseAuroraIconPackBundle } from "@/kernel/lib/icons/aurora-icon-pack";

const bundleWith = (icon: string) =>
    JSON.stringify({
        format: "aurora-pack",
        schemaVersion: 1,
        packageType: "icon-pack",
        manifest: { id: "p", name: "P", version: "1.0.0" },
        icons: { _file: icon },
        mappings: { defaultFile: "_file" },
    });

describe("icon payloads the parser must accept", () => {
    it("takes a data URI unchanged", () => {
        const parsed = parseAuroraIconPackBundle(bundleWith("data:image/png;base64,AAAA"));
        expect(parsed.icons._file).toBe("data:image/png;base64,AAAA");
    });

    it("encodes bare SVG markup", () => {
        const parsed = parseAuroraIconPackBundle(bundleWith("<svg viewBox='0 0 1 1'/>"));
        expect(parsed.icons._file.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    });

    /// `<svg` is where the markup starts, not where the file starts. Anything
    /// Inkscape saves opens with an XML prolog — VSCode Great Icons ships 244
    /// such files, and one of them rejected the entire theme on import.
    it("accepts an SVG behind an XML prolog", () => {
        const parsed = parseAuroraIconPackBundle(
            bundleWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\r\n<svg/>'),
        );
        expect(parsed.icons._file.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    });

    it("accepts an SVG behind a licence comment or a doctype", () => {
        for (const payload of [
            "<!-- Created with Inkscape -->\n<svg viewBox='0 0 1 1'/>",
            '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg/>',
        ]) {
            const parsed = parseAuroraIconPackBundle(bundleWith(payload));
            expect(parsed.icons._file.startsWith("data:image/svg+xml;utf8,")).toBe(true);
        }
    });

    /// The check has to stay a check. Text that is not an image must still be
    /// refused, or a broken pack imports and every icon renders blank.
    it("still refuses something that is not an image", () => {
        expect(() => parseAuroraIconPackBundle(bundleWith("just some text"))).toThrow(
            /data URI or inline SVG/,
        );
        expect(() => parseAuroraIconPackBundle(bundleWith("<html><body/></html>"))).toThrow();
    });
});
