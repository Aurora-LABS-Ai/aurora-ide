/**
 * Point Monaco at the copy we ship, not at a CDN.
 *
 * `@monaco-editor/react` defaults to loading Monaco from jsdelivr at runtime.
 * In a browser app that is merely a preference; in a desktop editor it is a
 * defect — open Aurora on a plane, a locked-down network, or a first launch
 * with no connectivity and the editor never appears, with no error that
 * explains why. `monaco-editor` is already an installed dependency, so the
 * bytes were sitting on disk the whole time.
 *
 * Importing this module has the side effect of the configuration, so it must be
 * imported before the first `<Editor>` / `<DiffEditor>` mounts. It is imported
 * by the three components that render Monaco rather than from a shared entry
 * point, which keeps ~5 MB of editor out of bundles that never show one — the
 * Agent Window in particular renders its code with Shiki and must not pay for
 * this.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

let configured = false;

/**
 * Idempotent: the three call sites each import this module, and a second
 * `loader.config` after Monaco has begun initialising throws.
 */
export function setupMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });
}

setupMonaco();
