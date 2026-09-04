/**
 * Aurora Chat's opening moves.
 *
 * The Build side builds its four starters from the workspace it is pointed at
 * (`workspace-starter-prompts.ts`). Chat has no workspace, so there is nothing
 * to build them from and nothing to branch on — they are four fixed lines.
 *
 * Every one of them names something this side can actually do: search the web
 * and cite it, explain, weigh two options, and look back through earlier
 * chats. Nothing here asks for a file, a repository or a command, because a
 * starter the product cannot honour is worse than no starter at all.
 *
 * Each prompt ends MID-SENTENCE on purpose. A workspace starter can be a whole
 * request because the project supplies the subject; here the user is the only
 * one who knows it, and the draft lands in the composer with the caret at the
 * end, ready to be finished.
 *
 * Icons are not chosen here, matching the workspace set: a starter declares a
 * semantic `kind` and the view maps it to a glyph.
 */

/** What a chat starter is FOR. Also its stable React key. */
export type ChatStarterKind = "research" | "explain" | "compare" | "recall";

export interface ChatStarterPrompt {
  kind: ChatStarterKind;
  /** The row label the user reads and clicks. */
  title: string;
  /** What lands in the composer, for the user to finish. */
  prompt: string;
}

export const CHAT_STARTER_PROMPTS: readonly ChatStarterPrompt[] = [
  {
    kind: "research",
    title: "Research a question and show the sources",
    prompt: "Research this and give me the sources you used, so I can check them: ",
  },
  {
    kind: "explain",
    title: "Explain something in plain language",
    prompt:
      "Explain this in plain language, and tell me what people usually get wrong about it: ",
  },
  {
    kind: "compare",
    title: "Compare two options and pick one",
    prompt: "Compare these options, then tell me which one you would pick and why: ",
  },
  {
    kind: "recall",
    title: "Find what we said in an earlier chat",
    prompt: "Look through our earlier chats and tell me what we said about: ",
  },
];
