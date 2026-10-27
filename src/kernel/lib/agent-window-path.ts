/**
 * Is this page the agent window?
 *
 * The desktop opens it at exactly `/agent-window`. In a browser the address
 * also carries the open project and chat (`/agent-window/p/<slug>/<id>`,
 * `apps/agent/lib/navigation/web-chat-url.ts`), so an exact match would send
 * those addresses to the IDE.
 */
export const isAgentWindowPath = (
  pathname: string = typeof window !== "undefined" ? window.location.pathname : "/",
): boolean => pathname === "/agent-window" || pathname.startsWith("/agent-window/");
