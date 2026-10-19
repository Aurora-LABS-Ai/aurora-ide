import { Fragment } from "react";

import { inlineRuns } from "@/apps/agent/lib/reply-layout/parse";

/** Layout fields allow text and code, never HTML or executable markdown. */
export function Field({ text }: { text: string }) {
  return <>{inlineRuns(text).map((run, i) =>
    run.kind === "code" ? <code key={i}>{run.text}</code> : <Fragment key={i}>{run.text}</Fragment>,
  )}</>;
}
