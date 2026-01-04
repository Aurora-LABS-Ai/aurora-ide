/**
 * Theme System Type Definitions
 * 
 * Defines all interfaces for Aurora's VS Code-style theme system including:
 * - ThemeTokens: 50+ color tokens across 7 categories
 * - ThemeFile: JSON schema for theme files
 * - ThemeDefinition: Runtime theme representation
 * - TokenColorRule: TextMate-style syntax highlighting rules
 * 
 * Requirements: 7.1, 7.2, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

// ============================================================================
// Symbol Types (for Breadcrumb Navigation - included for completeness)
// ============================================================================
/**
 * Chat panel color tokens (Requirement 10.4)
 * Covers: background, userMessage, assistantMessage, thinking, toolCall states
 */
export interface ChatTokens {
  assistantMessage: string;
  background: string;
  codeBlock: string;
  inputBackground: string;
  inputBorder: string;
  surface: string;
  surfaceBorder: string;
  surfaceMuted: string;
  thinkingBackground: string;
  thinkingBorder: string;
  toolCallBackground: string;
  toolCallBorder: string;
  usageHigh: string;
  usageLow: string;
  usageMedium: string;
  userMessage: string;
}

/**
 * Color value validation result
 */
export interface ColorValidationResult {
  error?: string;
  normalizedValue?: string;
  valid: boolean;
}

/**
 * Common/shared color tokens (Requirement 10.6)
 * Covers: primary, secondary, success, warning, error, border colors
 */
export interface CommonTokens {
  border: string;
  borderHover: string;
  error: string;
  errorForeground: string;
  info: string;
  infoForeground: string;
  overlay: string;
  primary: string;
  primaryForeground: string;
  primaryHover: string;
  scrollbar: string;
  scrollbarHover: string;
  secondary: string;
  secondaryForeground: string;
  secondaryHover: string;
  shadow: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
}

// ============================================================================
// Database Types
// ============================================================================

/**
 * Database representation of a custom theme
 */
export interface DbTheme {
  author: string;
  created_at: string;
  id: string;
  name: string;
  theme_json: string; // Serialized ThemeFile
  type: 'dark' | 'light';
  updated_at: string;
  version: string;
}

// ============================================================================
// Theme Token Categories (Requirements 10.1 - 10.6)
// ============================================================================

/**
 * Editor color tokens (Requirement 10.2)
 * Covers: background, foreground, lineNumbers, selection, cursor, syntax highlighting
 */
export interface EditorTokens {
  background: string;
  cursor: string;
  cursorLine: string;
  findMatch: string;
  findMatchHighlight: string;
  foreground: string;
  indentGuide: string;
  lineNumbers: string;
  lineNumbersActive: string;
  matchingBracket: string;
  selection: string;
  selectionHighlight: string;
  whitespace: string;
  wordHighlight: string;
}

// ============================================================================
// Monaco Theme Types
// ============================================================================

/**
 * Monaco editor theme data structure
 * Compatible with monaco.editor.IStandaloneThemeData
 */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  colors: Record<string, string>;
  inherit: boolean;
  rules: MonacoTokenRule[];
}

/**
 * Monaco token rule for syntax highlighting
 */
export interface MonacoTokenRule {
    background?: string;
  fontStyle?: string;
    foreground?: string;
  token: string;
}

/**
 * Sidebar color tokens (Requirement 10.3)
 * Covers: background, foreground, border, hover, active states
 */
export interface SidebarTokens {
  background: string;
  border: string;
  foreground: string;
  itemActive: string;
  itemHover: string;
  itemSelected: string;
  sectionHeader: string;
}

/**
 * Status bar color tokens
 * Covers: background, foreground, border, hover states
 */
export interface StatusBarTokens {
  background: string;
  border: string;
  foreground: string;
  itemHover: string;
}

export interface SymbolInfo {
  children?: SymbolInfo[];
  kind: SymbolKind;
  name: string;
  range: { startLine: number; endLine: number };
}

/**
 * Terminal color tokens (Requirement 10.5)
 * Covers: background, foreground, cursor, ANSI color mappings
 */
export interface TerminalTokens {
  background: string;

  // ANSI colors (standard 16-color palette)
  black: string;
  blue: string;
  brightBlack: string;
  brightBlue: string;
  brightCyan: string;
  brightGreen: string;
  brightMagenta: string;
  brightRed: string;
  brightWhite: string;
  brightYellow: string;
  cursor: string;
  cyan: string;
  foreground: string;
  green: string;
  magenta: string;
  red: string;
  selection: string;
  white: string;
  yellow: string;
}

/**
 * Theme store actions
 */
export interface ThemeActions {
  /** Delete a custom theme (built-in themes cannot be deleted) */
  deleteTheme: (themeId: string) => Promise<void>;

  /** Get the currently active theme */
  getActiveTheme: () => ThemeDefinition;

  /** Get a theme by ID */
  getTheme: (themeId: string) => ThemeDefinition | undefined;

  /** Import a theme from a ThemeFile */
  importTheme: (themeFile: ThemeFile) => Promise<ThemeDefinition>;

  /** Initialize themes from database */
  initializeFromDatabase: () => Promise<void>;

  /** Set the active theme by ID */
  setActiveTheme: (themeId: string) => Promise<void>;
}

// ============================================================================
// Runtime Theme Definition
// ============================================================================

/**
 * Complete runtime theme definition with resolved tokens
 * Used internally after theme file is loaded and merged with base
 */
export interface ThemeDefinition {
  /** Theme author */
  author: string;

  /** Fully resolved color tokens (no undefined values) */
  colors: ThemeTokens;

  /** Unique identifier */
  id: string;

  /** Whether this is a built-in theme (cannot be deleted) */
  isBuiltIn: boolean;

  /** Display name */
  name: string;

  /** Syntax highlighting rules */
  tokenColors: TokenColorRule[];

  /** Theme type (dark/light) */
  type: 'dark' | 'light';

  /** Version string */
  version: string;
}

// ============================================================================
// Theme File Schema (Requirements 8.1, 8.2, 8.3)
// ============================================================================

/**
 * Theme file JSON schema
 * Supports partial definitions where undefined tokens fall back to base theme
 */
export interface ThemeFile {
  /** Theme author/creator */
  author: string;

  /** Color tokens (partial allowed - falls back to base theme) */
  colors: DeepPartial<ThemeTokens>;

  /** Optional description */
  description?: string;

  /** Theme display name */
  name: string;

  /** TextMate-style syntax highlighting rules */
  tokenColors: TokenColorRule[];

  /** Theme type determines base fallback colors */
  type: 'dark' | 'light';

  /** Semantic version string */
  version: string;
}

// ============================================================================
// Theme Store Types
// ============================================================================

/**
 * Theme state for Zustand store
 */
export interface ThemeState {
  /** Currently active theme ID */
  activeThemeId: string;

  /** Error state */
  error: string | null;

  /** Loading state */
  isLoading: boolean;

  /** All available themes (built-in + custom) */
  themes: ThemeDefinition[];
}

// ============================================================================
// Complete Theme Tokens (Requirement 7.1, 7.2 - 50+ tokens across 7 categories)
// ============================================================================

/**
 * Complete theme token structure containing all color definitions
 * Organized into 7 categories: Editor, Sidebar, Chat, Terminal, StatusBar, TitleBar, Common
 */
export interface ThemeTokens {
  chat: ChatTokens;
  common: CommonTokens;
  editor: EditorTokens;
  sidebar: SidebarTokens;
  statusBar: StatusBarTokens;
  terminal: TerminalTokens;
  titleBar: TitleBarTokens;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Result of theme file validation
 */
export interface ThemeValidationResult {
  /** List of validation errors (empty if valid) */
  errors: string[];

  /** Whether the theme file is valid */
  valid: boolean;

  /** Warnings that don't prevent loading but should be noted */
  warnings: string[];
}

/**
 * Title bar color tokens
 * Covers: background, foreground, border, button hover
 */
export interface TitleBarTokens {
  background: string;
  border: string;
  buttonHover: string;
  foreground: string;
}

// ============================================================================
// Syntax Highlighting (TextMate-style token colors)
// ============================================================================

/**
 * TextMate-style token color rule for syntax highlighting
 * Used by Monaco editor for code colorization
 */
export interface TokenColorRule {
  /** Optional descriptive name for the rule */
  name?: string;

  /** TextMate scope(s) this rule applies to */
  scope: string | string[];

  /** Color and style settings */
  settings: {
    foreground?: string;
    background?: string;
    fontStyle?: 'italic' | 'bold' | 'underline' | 'strikethrough' | 'italic bold' | 'bold italic';
  };
}

/**
 * Map of CSS variable names to their values
 */
export type CSSVariableMap = Record<CSSVariableName, string>;

// ============================================================================
// CSS Variable Types
// ============================================================================

/**
 * CSS variable name pattern: --aurora-{category}-{token}
 */
export type CSSVariableName = `--aurora-${string}-${string}`;

/**
 * Deep partial utility type for nested optional properties
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type SymbolKind = 
  | 'function' 
  | 'class' 
  | 'interface' 
  | 'variable' 
  | 'method' 
  | 'property' 
  | 'enum' 
  | 'type';

/**
 * Complete theme store interface
 */
export type ThemeStore = ThemeState & ThemeActions;
