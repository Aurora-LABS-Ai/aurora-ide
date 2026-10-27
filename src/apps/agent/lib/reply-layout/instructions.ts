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

/** A small `aurora-ui` layout that parses clean: a test fixture. */
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
 * The standing prompt says when to lay a reply out and that the guide comes
 * first; the language itself lives only in `guide.md` (`canvas_guidelines`,
 * topic `reply-layout`). Alvan's call, 2026-10-23: teaching the parts in the
 * prompt grew it to ~3,000 characters and models still wrote from memory
 * (an unnamed fence, a 4-field Tree). One rule, one place for the language.
 *
 * Kept from earlier measurements (2026-10-15/16): a named moment (the final
 * summary of multi-step work), since without one models skipped blocks.
 *
 * 2026-10-27: "lays out its scannable parts in a fence" plus a guide that
 * listed markdown as "prose, headings and code" read as "lists and tables
 * belong in the fence, the rest is paragraphs". A DeepSeek architecture
 * summary came back as one fence and 22 paragraphs averaging 467 characters.
 * The fence now ADDS parts; structured markdown stays around it.
 */
export const REPLY_LAYOUT_INSTRUCTIONS = `## Reply layout
Short answers stay plain markdown. A longer answer, and always the final summary of multi-step work, adds an \`aurora-ui\` fence for the parts it draws better than markdown (a diagram, a flow, stats, a checklist). Everything else stays structured markdown.
Never write one from memory: call \`canvas_guidelines\` with \`topic: "reply-layout"\` first unless its text is already in this conversation, then follow it exactly.`;
