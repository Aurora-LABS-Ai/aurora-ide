/**
 * Lead team-control tools (Phase 5, ground truth §5/§13).
 *
 * The **Lead** (the chat agent when Team mode is on) calls these to convene,
 * plan, build, integrate, inspect, and manage the Aurora Agent Team — all
 * while the user keeps talking in the Agent Window conversation. They are dispatched through
 * the frontend bridge to `team-agent-tools.ts`, which calls the Rust `team_*`
 * commands (the actual mutations + safety live server-side) and reveals the
 * embedded Agent Window Team screen.
 *
 * The model should only reach for these when Team mode is active. If the
 * feature is disabled the executor returns a deterministic error telling the
 * Lead to ask the user to enable it.
 */
import type { ToolDefinition } from "../types";

export const teamShowTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_show",
    description: `Reveal the live Team panel (right side, beside the chat) for the current workspace. It streams the team group chat and each member's live work in real time. Use this so the user can watch the team work. Safe to call anytime; idempotent.`,
    parameters: { type: "object", properties: {}, required: [] },
  },
};

export const teamStatusTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_status",
    description: `Read the current team state without changing anything. Returns the background-run status (idle/running/done/failed), live per-member states (working / waiting_input when a member waits on you / done / blocked, plus how many files each changed), and — once the run is finished — every member's own report. Use this to check where the team stands before deciding the next step.`,
    parameters: { type: "object", properties: {}, required: [] },
  },
};

export const teamChatTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_chat",
    description: `Look in on the team's group chat — the live conversation between the Lead and the ICs (messages, boundary questions, published contracts, review verdicts, lifecycle notes). Use this to see what the team is actually saying/doing while it works in the background, e.g. before you report progress to the user.`,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          description: "How many of the most-recent chat messages to read (default 40).",
        },
      },
      required: [],
    },
  },
};

export const teamMessageTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_message",
    description: `Say something to the team as the Lead. The message is posted in the group chat AND delivered directly into the working members' live conversations — they read it mid-work and act on it. Use it to share a decision, correct course, or steer direction mid-run without stopping anyone. Address one member with 'to'; omit it to reach everyone.`,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Your message to the team (plain language).",
        },
        to: {
          type: "string",
          description:
            "Optional: one member's id (from team_status) to deliver to just them.",
        },
      },
      required: ["text"],
    },
  },
};

export const teamReplyTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_reply",
    description: `Answer a team member's question. When a member calls ask_lead it pauses (waiting_input) until you reply — a question arriving in this conversation carries a questionId; answer it with this tool and the member resumes immediately with your answer. Combine with team_grant_scope when the member asked for write access.`,
    parameters: {
      type: "object",
      properties: {
        questionId: {
          type: "string",
          description: "The questionId from the member's question.",
        },
        text: {
          type: "string",
          description: "Your answer, concrete and decisive (1-4 sentences).",
        },
      },
      required: ["questionId", "text"],
    },
  },
};

export const teamGrantScopeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_grant_scope",
    description: `Grant a member write access to additional repo paths. Use when a member asks for access it genuinely needs (usually via ask_lead). Granted paths are transferred from any previous owner so ownership never overlaps, and the grant is announced in the team chat. Only grant paths whose transfer won't break another member's in-flight work.`,
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "The member's id (from team_status or its question).",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths to add to the member's scope.",
        },
      },
      required: ["agentId", "paths"],
    },
  },
};

export const teamDispatchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_dispatch",
    description: `Spawn a team of peer worker agents that work in parallel and can talk to each other. You define the team in this call: give each member a role, its full instructions (the members do not see this conversation — put everything they need in their task), and the paths it owns. Returns IMMEDIATELY; the team works in the background while you keep chatting. You stay the Lead: check on them with team_status / team_chat, steer them with team_message, and members can ask you questions with @lead. Do not call it again while a run is in progress.`,
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The overall objective, in plain language.",
        },
        members: {
          type: "array",
          description:
            "The team, one entry per member. Match the size to the work (or to what the user asked for). Scopes must not overlap between members.",
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                description: "Short role name for what this member builds, e.g. 'widgets-owner'.",
              },
              task: {
                type: "string",
                description:
                  "This member's full instructions: what to build, key decisions/constraints, exact file paths and names. Be specific — this is all they get.",
              },
              scope: {
                type: "array",
                items: { type: "string" },
                description:
                  "Repo-relative folders/files/globs this member owns and may write, e.g. ['modern_app/widgets/']. Owned by exactly one member.",
              },
            },
            required: ["role", "task", "scope"],
          },
        },
      },
      required: ["goal", "members"],
    },
  },
};

export const teamRemoveAgentTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_remove_agent",
    description: `Dismiss one IC from the running team by id. Its file ownership is released and its tasks are unassigned. Use to drop a member that is no longer needed. The Lead cannot remove itself — use team_disband to stop the whole team.`,
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "The IC's id/role to remove (as shown in team_status).",
        },
      },
      required: ["agentId"],
    },
  },
};

export const teamDisbandTool: ToolDefinition = {
  type: "function",
  function: {
    name: "team_disband",
    description: `Stop the whole team run (soft stop → Disbanded). The shared brain stays on disk so the run can be inspected later. Use when the work is done or the user wants to halt the team.`,
    parameters: { type: "object", properties: {}, required: [] },
  },
};

export const teamTools: ToolDefinition[] = [
  teamShowTool,
  teamStatusTool,
  teamChatTool,
  teamMessageTool,
  teamReplyTool,
  teamGrantScopeTool,
  teamDispatchTool,
  teamRemoveAgentTool,
  teamDisbandTool,
];
