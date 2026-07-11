/**
 * Team-view bridge — decouples the Lead's team tools from the surface that
 * renders the team.
 *
 * The team is no longer a separate OS window. It's an embedded screen inside
 * the agent window (a center-column takeover). But the Lead's team tools
 * (`team_show` / `team_dispatch`) live in a shared service and must not import
 * the agent-window store directly. So the agent window REGISTERS an opener on
 * mount and the tools just REQUEST it — same pattern as `question-bridge`.
 *
 * When no surface is registered (e.g. a headless run) the request is a no-op:
 * the team still runs, there's just nothing to reveal.
 */

type TeamViewOpener = () => void;

let opener: TeamViewOpener | null = null;

/** Register the surface that reveals the embedded team screen. Returns an unregister fn. */
export function registerTeamViewOpener(fn: TeamViewOpener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Ask the registered surface to reveal the team screen. No-op if none is registered. */
export function requestOpenTeamView(): void {
  opener?.();
}
