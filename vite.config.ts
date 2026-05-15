import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],

    build: {
        // Aurora ships as a Tauri desktop bundle — chunks are loaded
        // off the local disk, not the network, so large chunks are fine.
        chunkSizeWarningLimit: 4000,

        // Vite 8 — Rolldown replaces Rollup, but the option key is renamed.
        // Plugin/output shape is Rollup-compatible, so the body is unchanged.
        rolldownOptions: {
            // Suppress mixed static/dynamic import warnings (intentional for Tauri)
            onwarn(warning, warn) {
                // Skip warnings about mixed imports - these are intentional
                if (
                    warning.code === "MIXED_EXPORTS" ||
                    warning.message?.includes("dynamically imported by") ||
                    warning.message?.includes("dynamic import will not move")
                ) {
                    return;
                }
                warn(warning);
            },

            output: {
                // Only split out the few genuinely-massive libraries that
                // benefit from their own chunk. Everything else stays in
                // Rollup's auto-split — manually carving up the React /
                // markdown / icon ecosystem caused circular-eval TDZ
                // crashes in release builds (Vite + manualChunks foot-gun:
                // chunk A holds a class, chunk B imports it but is
                // evaluated first → "Cannot access X before init"). Keep
                // this list conservative.
                manualChunks(id) {
                    if (!id.includes("node_modules")) return;

                    // Monaco editor (~2-3 MB parsed). Standalone — no
                    // shared deps with the rest of the app.
                    if (id.includes("monaco-editor")) return "monaco";

                    // XTerm terminal stack.
                    if (
                        id.includes("/@xterm/") ||
                        id.includes("/xterm/") ||
                        id.includes("\\@xterm\\") ||
                        id.includes("\\xterm\\")
                    ) {
                        return "xterm";
                    }

                    // Mermaid diagram engine (~1 MB+). Lazy-loaded by the
                    // markdown renderer.
                    if (id.includes("/mermaid/") || id.includes("\\mermaid\\")) {
                        return "mermaid";
                    }
                },
            },
        },

        // Vite 8: Oxc is the native minifier — drops the legacy esbuild
        // step from the pipeline and produces smaller output for ES2022.
        minify: "oxc",

        // Target modern browsers for smaller output
        target: "esnext",

        // Enable source maps only in dev
        sourcemap: false,
    },

    // Optimize dependencies
    optimizeDeps: {
        include: ["react", "react-dom", "zustand", "@monaco-editor/react"],
    },

    // Dev server config
    server: {
        proxy: {
            "/proxy/ollama": {
                target: "http://localhost:11434",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/proxy\/ollama/, ""),
            },
            "/proxy/lmstudio": {
                target: "http://localhost:1234",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/proxy\/lmstudio/, ""),
            },
        },
    },

    // Reduce console output
    logLevel: "warn",
});
