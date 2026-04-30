import type { ThemeFile } from "../../types/theme";

export const THEME_TEMPLATE: ThemeFile = {
  name: "My Custom Theme",
  type: "dark",
  author: "Your Name",
  version: "1.0.0",
  colors: {
    editor: {
      background: "#1a1a1a",
      foreground: "#e4e4e7",
    },
    common: {
      primary: "#10b981",
    },
  },
  tokenColors: [],
};
