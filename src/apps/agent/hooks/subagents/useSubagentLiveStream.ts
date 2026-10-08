/**
 * Follow every running sub-agent's stream for the life of the window [hook].
 * Mounted once from `AgentWindow`. See `services/subagents/live-stream.ts`.
 */

import { useEffect } from "react";

import { startSubagentLiveStream } from "@/apps/agent/services/subagents/live-stream";

export function useSubagentLiveStream(): void {
  useEffect(() => startSubagentLiveStream(), []);
}
