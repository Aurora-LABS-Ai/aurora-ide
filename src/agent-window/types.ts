/**
 * Agent Window — shared types (leaf layer).
 *
 * Per the global modular rules this is the in-most layer: it imports nothing
 * else in the module and everything else may depend on it. Cross-cutting type
 * contracts for the agent window live here.
 */

export type AgentAppearance = "dark" | "light";

/**
 * The agent window's design contract. Applied as scoped CSS custom properties
 * (`--agw-*`) on `.agw-root`, fully isolated from the IDE's `--aurora-*` theme.
 */
export interface AgentThemeTokens {
  // ── Surfaces (back → front) ──────────────────────────────────────────
  canvas: string;
  rail: string;
  conversation: string;
  dock: string;
  surface: string;
  surfaceElevated: string;
  /** Composer (message input) fill. Its OWN token — separate from
   *  `surfaceElevated` — so the input box can be themed independently of the
   *  menus / pills / selected rows that share the elevated surface. Defaults to
   *  the same value as `surfaceElevated` in the built-in themes. */
  composerSurface: string;
  overlay: string;

  // ── Text ─────────────────────────────────────────────────────────────
  text: string;
  textMuted: string;
  textSubtle: string;
  onAccent: string;

  // ── Lines & focus ────────────────────────────────────────────────────
  border: string;
  borderStrong: string;
  ring: string;

  // ── Brand ────────────────────────────────────────────────────────────
  accent: string;
  accentHover: string;

  // ── Semantic (diffs, status) ─────────────────────────────────────────
  added: string;
  addedSurface: string;
  removed: string;
  removedSurface: string;
  warning: string;
  info: string;

  // ── Conversation atoms ───────────────────────────────────────────────
  bubbleUser: string;
  bubbleAssistant: string;
  codeSurface: string;
  codeBorder: string;
  chipSurface: string;
  chipText: string;

  /** Faint translucent fill for idle/disabled controls (e.g. the send disc
   *  before there's text). Must read on top of `surfaceElevated`. */
  controlMuted: string;
  /** Hover fill for quiet list rows / suggestion chips. */
  hover: string;

  // ── Scrollbar ────────────────────────────────────────────────────────
  scrollThumb: string;
  scrollThumbHover: string;

  // ── Elevation ────────────────────────────────────────────────────────
  /** Drop shadow for popovers / dropdowns (model selector, menus). */
  shadowPop: string;

  // ── Typography & shape (non-color) ───────────────────────────────────
  fontUi: string;
  fontCode: string;
  /** Nested inside a container (inner panels, inline code, list rows). */
  radiusSm: string;
  /** Controls: buttons, inputs, chips with square-ish ends. */
  radiusMd: string;
  /** Containers: cards, popovers, panels, dialogs. */
  radiusLg: string;
  /** Fully-round ends: pills, avatars, progress tracks. */
  radiusPill: string;
}

export interface AgentTheme {
  id: string;
  name: string;
  appearance: AgentAppearance;
  tokens: AgentThemeTokens;
}

/**
 * Surfaces hosted by the right side dock. Codex models this as a dynamic,
 * browser-style tab system (see CODEX-UI-REFERENCE §12.7): singleton surfaces
 * (Review / Canvas / Files / Browser / Terminal) plus one `file` tab per opened file.
 */
export type DockTabKind =
  | "review"
  | "canvas"
  | "files"
  | "browser"
  | "terminal"
  | "team"
  | "file"
  | "member"
  | "project"
  | "chat";

/** The singleton (one-instance) tab kinds — everything except the per-file,
 *  per-team-member, per-project and per-conversation tabs. */
export type DockSingletonKind = Exclude<
  DockTabKind,
  "file" | "member" | "project" | "chat"
>;

export const DOCK_TAB_LABELS: Record<DockSingletonKind, string> = {
  review: "Review",
  canvas: "Canvas",
  files: "Files",
  browser: "Browser",
  terminal: "Terminal",
  team: "Team",
};

/** A live tab in the dock's strip. Singletons use their kind as the id; file
 *  tabs use `file:<absolutePath>`, team-member tabs `member:<agentId>` and
 *  conversation tabs `chat:<threadId>`, so re-opening the same one refocuses it
 *  instead of stacking duplicates. */
export interface DockTabInstance {
  id: string;
  kind: DockTabKind;
  title: string;
  /** Absolute path — only for `kind === "file"`. */
  path?: string;
  /** Team agent id — only for `kind === "member"`. */
  memberId?: string;
  /** Workspace folder — only for `kind === "project"`. */
  projectRoot?: string;
  /** Conversation id — only for `kind === "chat"`. */
  threadId?: string;
  /**
   * The project that conversation belongs to — only for `kind === "chat"`.
   *
   * Carried on the tab rather than read from the window's current scope: a
   * docked chat keeps running against ITS project even after you re-scope the
   * window to another one, so its tools must stay rooted where it started.
   */
  threadProjectRoot?: string | null;
}
