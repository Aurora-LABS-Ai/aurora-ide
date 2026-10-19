/**
 * What the model is told about reply layout. Pushed into the system prompt
 * only while Transcript → Reply layout is on, the way the chapter instruction
 * follows its switch, so a reply never carries a fence the window will not
 * draw.
 *
 * Since 2026-10-16 the model is taught one fence, `aurora-ui` (`ui.ts`), in
 * place of the nine single-block fences (Alvan's call, after the probe
 * `Documents/aurora-reply-language-designs.html`). Every example here parses
 * with no problems — `instructions.test.ts` runs them through the parsers, so
 * the instruction cannot teach a line the parser rejects.
 */

import royalties from "@/canvas-sdk/reporting/examples/royalties.json";

/** The three parts the standing prompt shows, one line each. */
export const UI_PROMPT_LINES = [
  `root = Page([stack, steps, risk])`,
  `stack = Facts("Stack", ["Runtime | Rust | Tauri backend", "Interface | React | Two windows"])`,
  `steps = Flow("Request", ["Gate | \`proxy.ts\` checks the cookie", "Render | Server component reads the database"])`,
  `risk = Note("Not verified", ["File | \`app/page.tsx\`"], "Not run in a browser.")`,
] as const;

/**
 * The single-block fences the model was taught before `aurora-ui`. Old chats
 * still hold them and they still draw; tests use these as fixtures.
 */
export const REPLY_LAYOUT_EXAMPLES = {
  report: JSON.stringify(royalties, null, 2),
  facts: `Framework | Next.js 16.2.3 | App Router · React 19
Database | PostgreSQL | Prisma 7 · adapter-pg
Authentication | NextAuth v5 | Beta · JWT strategy
State | Zustand | Cart · wishlist`,
  flow: `Incoming request
\`proxy.ts\` | Single routing and access-control gate
Storefront \`/\` || Admin \`/admin\` || Auth \`/auth\` || API \`/api\`
Server Components / Route Handlers | Prisma 7 · server-side data access
PostgreSQL | Single database · one deployable`,
  note: `The route-group trap
File location | \`app/(client)/test-assets/page.tsx\`
Actual public URL | \`/test-assets\`
The folder is under the group, so the URL drops it and a folder-tree search for the path finds nothing.`,
  bars: `Client components
\`app/*.tsx\` | 31 / 97
\`components/\` | 155 / 193 | the islands live here`,
  pairs: `Route structure
\`app/(client)/\` | Storefront
\`app/admin/\` | Admin
\`app/auth/(shell)/\` | Auth
\`app/api/\` | 95 handlers
\`proxy.ts\` | 4 access gates`,
  compare: `Rendering choices
Aspect | Server rendering | Client rendering
Execution | Server | Browser
Interactivity | Needs client islands | Local event handlers
Best fit | Data loading | Interactive controls`,
  checklist: `Release readiness
done | Build | Production bundle generated
doing | Regression checks | Two scenarios remain
blocked | Signing | Certificate required
todo | Publish | After checks and signing`,
  timeline: `Incident timeline
09:10 UTC | First failed request | Database connection refused
09:18 UTC | Service restored | Connection settings corrected
09:30 UTC | Verification complete | Error rate returned to baseline`,
  tree: `Module ownership
0 | Agent window | Conversation interface
1 | Components | Render the transcript
2 | Reply layout | Draw explanation blocks
1 | Services | Compose prompts and call the runtime
0 | Kernel | Shared state and types`,
} as const;

/**
 * Measured 2026-10-15/16: about 31 long replies went out without a block and
 * 9 used one, several only after Alvan asked. The old text made a guide call a
 * precondition ("before the first layout block, load …") and named no moment
 * to use a block, so models paid nothing by skipping it. The three common
 * formats are now taught in one line each, the final summary is the named
 * trigger, and the guide is for the rest.
 *
 * Same day, first live run (DeepSeek V4.1 Flash, rules off): blocks came
 * unprompted, but each opened with a header row (`Surface | Location | Notes`,
 * `Step | Detail`) copied from placeholder words. The rows are real examples,
 * and in `aurora-ui` the title is its own argument, so a title can no longer
 * be mistaken for a row.
 */
export const REPLY_LAYOUT_INSTRUCTIONS = `## Reply layout
Short answers stay plain markdown. A longer answer, and always the final summary of multi-step work, lays out its scannable parts in a fence named \`aurora-ui\` instead of bullet lists: one part per line, root first, each part drawn as its line ends. Text in quotes; rows are \`a | b | c\` strings with no header row:
${UI_PROMPT_LINES.join("\n")}
Facts for results, changes and checks; Flow for steps in order; Note for one caveat or what is unverified. Prose explains around the fence and never repeats a part. \`canvas_guidelines\` with \`topic: "reply-layout"\` has the other parts (Stats, Diagram, Link, Sources, Pairs, Compare, Checklist, Timeline, Tree, Text); \`topic: "reports"\` has the \`aurora-report\` JSON for data with filters and charts. Load one only when you use those.`;
