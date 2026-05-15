import { EXT_TO_LANGUAGE } from "./helpers";

/**
 * Open a tool-result file (grep hit, multi-file read entry, file-card
 * chip) in the Monaco editor. Dynamic imports keep the editor / file-
 * cache / path-resolver out of the chat bundle's critical path —
 * tool cards are far more numerous than openFile calls.
 */
export async function openFileInEditor(
  path: string,
  options?: { fallbackContent?: string },
): Promise<void> {
  try {
    const [{ useEditorStore }, { resolvePath }, { readFileContent }] =
      await Promise.all([
        import("../../../store/useEditorStore"),
        import("../../../tools/utils/path-resolver"),
        import("../../../lib/tauri"),
      ]);

    const fullPath = resolvePath(path);
    const fileName = fullPath.split(/[/\\]/).pop() || path;
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const language = EXT_TO_LANGUAGE[ext] || ext || "plaintext";

    let content = options?.fallbackContent ?? "";
    try {
      content = await readFileContent(fullPath);
    } catch (err) {
      // The file may have been deleted since the tool ran. Fall back
      // to whatever payload the caller already had on hand.
      console.warn("[tool-timeline] readFileContent failed:", err);
    }

    useEditorStore.getState().openFile(fullPath, fileName, content, language);
  } catch (err) {
    console.error("[tool-timeline] openFileInEditor failed:", err);
  }
}
