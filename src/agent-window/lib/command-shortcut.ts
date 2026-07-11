const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift"]);

function normalizedKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = normalizedKey(event.key);
  const modifiers = [
    event.ctrlKey || event.metaKey ? "Mod" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter((part): part is string => part !== null);
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...modifiers, key].join("+");
}

export function matchesCommandShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+").filter(Boolean);
  const key = parts.at(-1);
  if (!key || normalizedKey(event.key) !== key) return false;
  return (
    (event.ctrlKey || event.metaKey) === parts.includes("Mod") &&
    event.altKey === parts.includes("Alt") &&
    event.shiftKey === parts.includes("Shift")
  );
}

export function formatCommandShortcut(shortcut: string): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return shortcut
    .split("+")
    .map((part) => (part === "Mod" ? (isMac ? "⌘" : "Ctrl") : part))
    .join("+");
}
