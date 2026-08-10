/**
 * Attachment shapes shared between a composer and the context builder.
 *
 * `AttachedFile` used to be declared inside the IDE's `ChatInput.tsx`, which
 * meant `services/context-builder.ts` — code the agent window depends on —
 * had a type-only import pointing into an IDE chat component. That edge is
 * erased at build time but it made the whole IDE chat subtree look
 * load-bearing for the agent window. It lives here so neither product owns
 * the other's types.
 */

/** A workspace file attached to a prompt. Metadata only — no content. */
export interface AttachedFile {
  path: string;
  name: string;
}
