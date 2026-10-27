/**
 * The agent window's address in a browser: which project and chat are open.
 *
 *   /agent-window                       the home screen
 *   /agent-window/p/<project-slug>      a project, no chat open
 *   /agent-window/p/<project-slug>/<id> a project chat
 *   /agent-window/c/<id>                an Aurora Chat conversation
 *
 * The slug is the one the backend names the project's folder by
 * (`agent_runtime/project_dir.rs::slug`): lowercase, every character that is
 * not a letter or digit becomes `-`, so `E:\VOID-EDITOR\Aurora` is
 * `e--void-editor-aurora`. It is matched back to a project the window
 * already knows, never turned back into a path.
 */

export const AGENT_WINDOW_PATH = "/agent-window";

export type WebChatLocation =
  | { kind: "home" }
  | { kind: "project"; slug: string; threadId: string | null }
  | { kind: "chat"; threadId: string };

export const projectSlug = (root: string): string =>
  root
    .replace(/[\\/]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");

export const webChatPath = (location: WebChatLocation): string => {
  switch (location.kind) {
    case "home":
      return AGENT_WINDOW_PATH;
    case "project":
      return location.threadId
        ? `${AGENT_WINDOW_PATH}/p/${location.slug}/${encodeURIComponent(location.threadId)}`
        : `${AGENT_WINDOW_PATH}/p/${location.slug}`;
    case "chat":
      return `${AGENT_WINDOW_PATH}/c/${encodeURIComponent(location.threadId)}`;
  }
};

export const parseWebChatPath = (pathname: string): WebChatLocation => {
  const rest = pathname.startsWith(AGENT_WINDOW_PATH)
    ? pathname.slice(AGENT_WINDOW_PATH.length)
    : "";
  const parts = rest.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "p" && parts[1]) {
    return { kind: "project", slug: parts[1], threadId: parts[2] ?? null };
  }
  if (parts[0] === "c" && parts[1]) {
    return { kind: "chat", threadId: parts[1] };
  }
  return { kind: "home" };
};

/** The project in `roots` the slug names, if any. */
export const projectForSlug = (slug: string, roots: readonly string[]): string | null =>
  roots.find((root) => projectSlug(root) === slug) ?? null;
