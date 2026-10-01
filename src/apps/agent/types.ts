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
  /**
   * The tint on SMALL CONTROLS — a switch that is on, the pinned tack in the
   * rail, the unread badge, the activity spinner and live dot.
   *
   * Its own token so `accent` can go neutral without those going grey with it.
   * A monochrome or near-monochrome theme is a real thing people want, and with
   * one accent doing both jobs it is not expressible: turning the brand colour
   * to black or white also erases the only tint distinguishing an on switch
   * from an off one.
   *
   * Ships equal to `accent` in both built-in themes, so nothing changes until
   * someone sets it.
   */
  controlAccent: string;

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
  /**
   * DISPLAY face — the hero wordmark, settings page and section headings, and
   * dialog titles. Nothing anyone READS at length: not transcript prose, not
   * message headings, not list rows.
   *
   * Ships equal to `fontUi`, so an untouched install renders exactly as before
   * and this is a knob rather than a redesign. Setting it is how the window
   * gains a second voice at the two or three places a product's identity
   * actually lands, without putting a display face anywhere it would cost
   * legibility.
   */
  fontDisplay: string;
  /** Multiplier on the chrome type scale, unitless (e.g. "1", "1.15"). */
  uiTextScale: string;
  /** Assistant message prose size (e.g. "15px"). */
  msgFontSize: string;
  /** Assistant message prose line-height (unitless, e.g. "1.75"). */
  msgLineHeight: string;
  /** Assistant message prose weight (e.g. "400"). */
  msgFontWeight: string;
  /** Fenced code block text size (e.g. "13px"). Absolute — a block is its own
   *  surface, so it does not scale with the prose the way inline code does. */
  msgCodeFontSize: string;
  /** Your-message bubble text size; the mid-turn note follows it. */
  msgUserFontSize: string;
  /** Your-message bubble line-height (unitless). */
  msgUserLineHeight: string;
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
  // Aurora Chat's own surface: what Aurora remembers about the user. Opened
  // from the rail, like Team.
  | "memory"
  | "file"
  | "member"
  | "project"
  | "chat"
  // One conversation's own numbers — turn timeline, tool outcomes, tokens.
  // Its own tab rather than a modal because it updates while a turn runs and
  // is read ALONGSIDE the transcript, and because project details already
  // open as a dock tab: the same idea one level down belongs in the same
  // container.
  | "session"
  // One saved artifact, opened from the Canvas index. Its own tab rather than
  // a selection inside Canvas: a conversation that produced six reports and
  // diagrams is browsed, and two of them are often read side by side.
  | "artifact"
  // What `+` opens: a browser New tab page that also lists Aurora's panels.
  // Picking a panel turns this tab into it; entering an address turns it into
  // a browser tab. Several can be open at once.
  | "newtab";

/** The singleton (one-instance) tab kinds — everything except the per-file,
 *  per-team-member, per-project, per-conversation, per-artifact and New tabs. */
export type DockSingletonKind = Exclude<
  DockTabKind,
  "file" | "member" | "project" | "chat" | "artifact" | "session" | "newtab"
>;

export const DOCK_TAB_LABELS: Record<DockSingletonKind, string> = {
  review: "Review",
  canvas: "Canvas",
  files: "Files",
  browser: "Browser",
  terminal: "Terminal",
  team: "Team",
  memory: "Memory",
};

/**
 * The dock surfaces Aurora Chat offers: Canvas, where it presents, and Memory,
 * what it keeps.
 *
 * Everything else on this list addresses a project — Files opens a tree, Review
 * shows diffs, Terminal reads the user's shells, Browser and Team drive tools
 * chat mode does not register. There are two doors onto these tabs (the dock's
 * `+` menu and the command palette), which is exactly why the roster is one
 * constant rather than a list written out twice.
 */
export const CHAT_DOCK_TABS: readonly DockSingletonKind[] = ["canvas", "memory"];

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
  /** Conversation id — for `kind === "chat"` and `kind === "session"`. */
  threadId?: string;
  /** Owning surface for a docked conversation. Missing on legacy saved tabs. */
  threadSurface?: "chat" | "build";
  /** Saved artifact id — only for `kind === "artifact"`. */
  artifactId?: string;
  /**
   * The project that conversation belongs to — only for `kind === "chat"`.
   *
   * Carried on the tab rather than read from the window's current scope: a
   * docked chat keeps running against ITS project even after you re-scope the
   * window to another one, so its tools must stay rooted where it started.
   */
  threadProjectRoot?: string | null;
  /**
   * The native page behind a `browser` tab. Absent on the agent's own tab (id
   * `browser`), which always uses `AGENT_BROWSER_LABEL`; every tab the user
   * opens from a New tab page carries its own label, so the agent never drives
   * a page the user opened.
   */
  browserLabel?: string;
  /** The page's last known address — for a `browser` tab. Restored on reload. */
  url?: string;
  /**
   * An address the panel still has to load — set when a New tab page becomes
   * a browser tab, cleared by the panel once it has navigated.
   */
  pendingUrl?: string;
  /**
   * The device a `browser` tab shows its page as (browser tools row). Kept on
   * the tab so closing the panel, switching tabs or restarting brings the page
   * back as the same device. Absent = the page at its natural size.
   */
  device?: "iphone" | "android" | "tablet";
  /** The page's zoom (1 = 100%). Absent = 100%. */
  zoom?: number;
  /** Whether the browser tools row is open on this tab. */
  toolsOpen?: boolean;
}
