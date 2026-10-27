/**
 * The file and folder picker in a browser.
 *
 * The desktop window opens the OS dialog (`@tauri-apps/plugin-dialog`). A
 * browser page has no such dialog for paths on the machine Aurora runs on,
 * so `openFileDialog` asks whatever picker the running app registered here.
 * The agent window registers `WebFilePicker`; until something registers, the
 * browser gets `null` (the same as a cancelled dialog) and a warning.
 */

export interface WebFilePickerRequest {
  directory: boolean;
  filters?: { name: string; extensions: string[] }[];
}

export type WebFilePicker = (request: WebFilePickerRequest) => Promise<string | null>;

let registered: WebFilePicker | null = null;

/** Register the picker; returns a function that removes it again. */
export const setWebFilePicker = (picker: WebFilePicker): (() => void) => {
  registered = picker;
  return () => {
    if (registered === picker) {
      registered = null;
    }
  };
};

/**
 * The folder above `path`, or `null` at a drive root or `/`. Unlike
 * `getParentPath` it keeps a drive's own backslash (`C:\Users` → `C:\`), which
 * is the only form a drive can be listed under.
 */
export const parentFolder = (path: string): string | null => {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed) || trimmed === "") return null;
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return null;
  const parent = trimmed.slice(0, cut);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent === "" ? "/" : parent;
};

/** Does a file pass the picker's extension filters? No filters, or `*`, pass all. */
export const matchesPickerFilters = (name: string, request: WebFilePickerRequest): boolean => {
  const extensions = request.filters?.flatMap((filter) => filter.extensions) ?? [];
  if (extensions.length === 0 || extensions.includes("*")) return true;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return extensions.some((wanted) => wanted.toLowerCase() === ext);
};

export const pickInBrowser = async (request: WebFilePickerRequest): Promise<string | null> => {
  if (!registered) {
    console.warn("openFileDialog: no picker is available in this page");
    return null;
  }
  return registered(request);
};
