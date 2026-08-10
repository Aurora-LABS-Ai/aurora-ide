/**
 * Agent Window — Team view atoms [shared leaf views].
 *
 * Small presentation pieces shared by the Team group-chat tab (`TeamPanel`)
 * and the per-member stream tabs (`MemberPanel`): the loading skeleton and the
 * live-draft bubble that renders an in-flight `team_stream` through the REAL
 * `MessageBubble` pipeline. Components only (fast-refresh rule) — the pure
 * draft helpers live in `team-ui.ts`.
 */

import React from "react";

import { MessageBubble } from "@/apps/agent/components/conversation/MessageBubble";
import type { TeamLiveDraft } from "@/apps/agent/store/team/useTeamStore";
import { draftEvents } from "@/apps/agent/components/team/team-ui";

/**
 * A live, in-flight reply — the token stream before the authoritative content
 * persists — rendered through the REAL `MessageBubble` (shimmer label, live
 * thinking block, markdown with a trailing cursor).
 */
export const LiveDraftTurn: React.FC<{
  draft: TeamLiveDraft;
  label?: string;
  labelColor?: string;
  showLabel: boolean;
}> = ({ draft, label, labelColor, showLabel }) => (
  <MessageBubble
    message={{
      role: "assistant",
      content: draft.text,
      isThinking: !draft.done && draft.thinking.trim() !== "" && draft.text.trim() === "",
    }}
    events={draftEvents(draft)}
    label={label}
    labelColor={labelColor}
    showLabel={showLabel}
    streaming={!draft.done}
    showActions={false}
  />
);

/** Shimmer placeholder shown while a view's messages are still loading. */
export const TeamChatSkeleton: React.FC = () => (
  <div className="agw-team-chat" aria-hidden>
    {[0, 1, 2].map((i) => (
      <div key={i} className="agw-team-skel">
        <div className="agw-team-skel-label" />
        <div className="agw-team-skel-line" style={{ width: "94%" }} />
        <div className="agw-team-skel-line" style={{ width: "80%" }} />
        <div className="agw-team-skel-line" style={{ width: "88%" }} />
      </div>
    ))}
  </div>
);
