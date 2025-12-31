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

export type SymbolKind = 
  | 'function' 
  | 'class' 
  | 'interface' 
  | 'variable' 
  | 'method' 
  | 'property' 
  | 'enum' 
  | 'type';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  range: { startLine: number; endLine: number };
  children?: SymbolInfo[];
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
  foreground: string;
  lineNumbers: string;
  lineNumbersActive: string;
  selection: string;
  selectionHighlight: string;
  cursor: string;
  cursorLine: string;
  whitespace: string;
  indentGuide: string;
  matchingBracket: string;
  wordHighlight: string;
  findMatch: string;
  findMatchHighlight: string;
}

/**
 * Sidebar color tokens (Requirement 10.3)
 * Covers: background, foreground, border, hover, active states
 */
export interface SidebarTokens {
  background: string;
  foreground: string;
  border: string;
  itemHover: string;
  itemActive: string;
  itemSelected: string;
  sectionHeader: string;
}

/**
 * Chat panel color tokens (Requirement 10.4)
 * Covers: background, userMessage, assistantMessage, thinking, toolCall states
 */
export interface ChatTokens {
  background: string;
  inputBackground: string;
  inputBorder: string;
  surface: string;
  surfaceBorder: string;
  surfaceMuted: string;
  usageLow: string;
  usageMedium: string;
  usageHigh: string;
  userMessage: string;
  assistantMessage: string;
  thinkingBackground: string;
  thinkingBorder: string;
  toolCallBackground: string;
  toolCallBorder: string;
  codeBlock: string;
}


/**
 * Terminal color tokens (Requirement 10.5)
 * Covers: background, foreground, cursor, ANSI color mappings
 */
export interface TerminalTokens {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  // ANSI colors (standard 16-color palette)
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Status bar color tokens
 * Covers: background, foreground, border, hover states
 */
export interface StatusBarTokens {
  background: string;
  foreground: string;
  border: string;
  itemHover: string;
}

/**
 * Title bar color tokens
 * Covers: background, foreground, border, button hover
 */
export interface TitleBarTokens {
  background: string;
  foreground: string;
  border: string;
  buttonHover: string;
}

/**
 * Common/shared color tokens (Requirement 10.6)
 * Covers: primary, secondary, success, warning, error, border colors
 */
export interface CommonTokens {
  primary: string;
  primaryHover: string;
  primaryForeground: string;
  secondary: string;
  secondaryHover: string;
  secondaryForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  error: string;
  errorForeground: string;
  info: string;
  infoForeground: string;
  border: string;
  borderHover: string;
  shadow: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
}


// ============================================================================
// Complete Theme Tokens (Requirement 7.1, 7.2 - 50+ tokens across 7 categories)
// ============================================================================

/**
 * Complete theme token structure containing all color definitions
 * Organized into 7 categories: Editor, Sidebar, Chat, Terminal, StatusBar, TitleBar, Common
 */
export interface ThemeTokens {
  editor: EditorTokens;
  sidebar: SidebarTokens;
  chat: ChatTokens;
  terminal: TerminalTokens;
  statusBar: StatusBarTokens;
  titleBar: TitleBarTokens;
  common: CommonTokens;
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

// ============================================================================
// Theme File Schema (Requirements 8.1, 8.2, 8.3)
// ============================================================================

/**
 * Theme file JSON schema
 * Supports partial definitions where undefined tokens fall back to base theme
 */
export interface ThemeFile {
  /** Theme display name */
  name: string;
  /** Theme author/creator */
  author: string;
  /** Semantic version string */
  version: string;
  /** Theme type determines base fallback colors */
  type: 'dark' | 'light';
  /** Optional description */
  description?: string;
  /** Color tokens (partial allowed - falls back to base theme) */
  colors: DeepPartial<ThemeTokens>;
  /** TextMate-style syntax highlighting rules */
  tokenColors: TokenColorRule[];
}

/**
 * Deep partial utility type for nested optional properties
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};


// ============================================================================
// Runtime Theme Definition
// ============================================================================

/**
 * Complete runtime theme definition with resolved tokens
 * Used internally after theme file is loaded and merged with base
 */
export interface ThemeDefinition {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Theme author */
  author: string;
  /** Version string */
  version: string;
  /** Theme type (dark/light) */
  type: 'dark' | 'light';
  /** Whether this is a built-in theme (cannot be deleted) */
  isBuiltIn: boolean;
  /** Fully resolved color tokens (no undefined values) */
  colors: ThemeTokens;
  /** Syntax highlighting rules */
  tokenColors: TokenColorRule[];
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Result of theme file validation
 */
export interface ThemeValidationResult {
  /** Whether the theme file is valid */
  valid: boolean;
  /** List of validation errors (empty if valid) */
  errors: string[];
  /** Warnings that don't prevent loading but should be noted */
  warnings: string[];
}

/**
 * Color value validation result
 */
export interface ColorValidationResult {
  valid: boolean;
  normalizedValue?: string;
  error?: string;
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
  /** All available themes (built-in + custom) */
  themes: ThemeDefinition[];
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: string | null;
}

/**
 * Theme store actions
 */
export interface ThemeActions {
  /** Set the active theme by ID */
  setActiveTheme: (themeId: string) => Promise<void>;
  /** Import a theme from a ThemeFile */
  importTheme: (themeFile: ThemeFile) => Promise<ThemeDefinition>;
  /** Delete a custom theme (built-in themes cannot be deleted) */
  deleteTheme: (themeId: string) => Promise<void>;
  /** Get a theme by ID */
  getTheme: (themeId: string) => ThemeDefinition | undefined;
  /** Get the currently active theme */
  getActiveTheme: () => ThemeDefinition;
  /** Initialize themes from database */
  initializeFromDatabase: () => Promise<void>;
}

/**
 * Complete theme store interface
 */
export type ThemeStore = ThemeState & ThemeActions;

// ============================================================================
// CSS Variable Types
// ============================================================================

/**
 * CSS variable name pattern: --aurora-{category}-{token}
 */
export type CSSVariableName = `--aurora-${string}-${string}`;

/**
 * Map of CSS variable names to their values
 */
export type CSSVariableMap = Record<CSSVariableName, string>;

// ============================================================================
// Monaco Theme Types
// ============================================================================

/**
 * Monaco editor theme data structure
 * Compatible with monaco.editor.IStandaloneThemeData
 */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: MonacoTokenRule[];
  colors: Record<string, string>;
}

/**
 * Monaco token rule for syntax highlighting
 */
export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

// ============================================================================
// Database Types
// ============================================================================

/**
 * Database representation of a custom theme
 */
export interface DbTheme {
  id: string;
  name: string;
  author: string;
  version: string;
  type: 'dark' | 'light';
  theme_json: string; // Serialized ThemeFile
  created_at: string;
  updated_at: string;
}
