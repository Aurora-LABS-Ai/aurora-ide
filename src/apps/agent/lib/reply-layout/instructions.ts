/**
 * What the model is told about reply layout blocks. Pushed into the system
 * prompt only while Transcript → Reply layout is on, the way the chapter
 * instruction follows its switch, so a reply never carries a fence the window
 * will not draw.
 *
 * Every example here parses clean — `instructions.test.ts` runs them through
 * `parseLayout`, so the instruction cannot teach a line the parser rejects.
 */

export const REPLY_LAYOUT_EXAMPLES = {
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
} as const;

export const REPLY_LAYOUT_INSTRUCTIONS = `## Reply layout
When you explain how something is built or report what you found — an architecture, a review, a flow, a comparison of parts — lay the reply out so it can be scanned, not only read. The same parts fit any explanation, not only code: a plan with its steps, a few options weighed against each other, how a process works, what something costs or contains. Five page parts are drawn inline by Aurora, between your normal sentences. Keep ordinary markdown for everything else, including headings for the sections of a long reply; a short answer or a direct reply needs none of them.

- Key facts, near the top, after the first sentence: three to five lines with the names and figures the reader will look for first. One per line, \`Label | Value | Caption\`; the caption is optional. A label is one or two words, a value is a name or a figure (under five words), a caption is a short phrase. File paths and line numbers go in the sentences, not in a fact.

\`\`\`aurora-facts
${REPLY_LAYOUT_EXAMPLES.facts}
\`\`\`

- A flow, when things happen in order: a request path, a pipeline, a build, a sign-in. One step per line, top to bottom, \`Title | Caption\`; \`||\` between items on one line draws them side by side as alternatives at that step. Three to seven steps.

\`\`\`aurora-flow
${REPLY_LAYOUT_EXAMPLES.flow}
\`\`\`

- A note, for one trap, exception or caveat worth a box of its own: the first line is its title, \`Label | Value\` lines become pairs, other lines are sentences. At most two notes in a reply.

\`\`\`aurora-note
${REPLY_LAYOUT_EXAMPLES.note}
\`\`\`

- Bars, when a few counts or shares are the point — how much of the code is client-side, how many of each kind, how far along something is. The first line is the title; then one bar per line, \`Label | 31 / 97\` or \`Label | 64%\`, with an optional \`| Caption\`. Two to six bars.

\`\`\`aurora-bars
${REPLY_LAYOUT_EXAMPLES.bars}
\`\`\`

- Pairs, for a lookup the reader will come back to: a route map, a set of config values, who owns what. The first line is the title; then \`Label | Value\` lines. Three to eight pairs. A note is for one caveat; pairs are for a plain list.

\`\`\`aurora-pairs
${REPLY_LAYOUT_EXAMPLES.pairs}
\`\`\`

Rules: fields hold plain text and \`code\` only, no markdown. Keep every field short; a block is for scanning, and anything that needs a clause belongs in the sentences. A block never repeats what the sentences beside it say, and the sentences never repeat the block. One facts block per reply, at the top. Never put one of these fences inside another code block. A line the block cannot read is skipped and shown to the user as an error, so write only the shapes above.`;
