/**
 * Interactive question bridge (frontend seam).
 *
 * `ask_question` is a frontend-native Aurora tool (like the skill tools) but,
 * unlike them, it is NOT a pure read — it has to PAUSE the agent turn and wait
 * for the user to answer in the UI. The tool executor (`aurora-tools.ts`) lives
 * outside React and can't open a panel itself, so it calls {@link requestUserQuestions}
 * here, which forwards to whatever window registered a handler (the agent window
 * registers one in `AgentWindow`).
 *
 * Mirrors the approval seam (`onToolApprovalRequired`): a single in-flight
 * Promise that resolves when the user submits/skips. If no handler is registered
 * (e.g. a context with no interactive surface), we degrade gracefully to a
 * "skipped" result so the model gets a deterministic answer instead of hanging
 * the tool loop forever.
 */

// ── Wire shapes ──────────────────────────────────────────────────────

export interface AskQuestionOption {
  id: string;
  label: string;
}

export interface AskQuestionItem {
  id: string;
  prompt: string;
  options: AskQuestionOption[];
  /** Allow more than one option to be chosen (checkbox vs radio). */
  allowMultiple?: boolean;
}

export interface AskQuestionRequest {
  /** Optional heading shown in the card (defaults to "Questions"). */
  title?: string;
  questions: AskQuestionItem[];
}

export interface AskQuestionAnswer {
  questionId: string;
  /** Ids of chosen predefined options. */
  selectedIds: string[];
  /** Free-text from the "Other…" affordance, when used. */
  otherText?: string;
}

export interface AskQuestionResult {
  /** User dismissed the prompt without answering. */
  skipped: boolean;
  answers: AskQuestionAnswer[];
}

export type QuestionHandler = (
  request: AskQuestionRequest,
) => Promise<AskQuestionResult>;

// ── Handler registry (one active surface at a time) ──────────────────

let activeHandler: QuestionHandler | null = null;

/**
 * Register the surface that renders interactive questions. Returns an
 * unregister fn; pass `null` to clear directly. The agent window calls this on
 * mount so its `useAgentQuestionStore` receives requests.
 */
export function registerQuestionHandler(
  handler: QuestionHandler | null,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/**
 * Forward a question request to the active surface and await the user's answer.
 * Degrades to `{ skipped: true }` when nothing is registered so the tool loop
 * never deadlocks.
 */
export async function requestUserQuestions(
  request: AskQuestionRequest,
): Promise<AskQuestionResult> {
  if (!activeHandler) {
    return { skipped: true, answers: [] };
  }
  return activeHandler(request);
}

// ── Arg normalisation (model JSON → typed request) ───────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeOptions(raw: unknown): AskQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestionOption[] = [];
  raw.forEach((entry, idx) => {
    if (typeof entry === "string") {
      out.push({ id: `opt${idx + 1}`, label: entry });
      return;
    }
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const label = asString(rec.label) ?? asString(rec.value) ?? asString(rec.text);
      if (!label) return;
      out.push({ id: asString(rec.id) ?? `opt${idx + 1}`, label });
    }
  });
  return out;
}

function normalizeQuestion(raw: unknown, idx: number): AskQuestionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const prompt = asString(rec.prompt) ?? asString(rec.question) ?? asString(rec.text);
  if (!prompt) return null;
  const options = normalizeOptions(rec.options ?? rec.choices ?? rec.answers);
  const allowMultiple =
    rec.allowMultiple === true || rec.allow_multiple === true || rec.multiple === true;
  return {
    id: asString(rec.id) ?? `q${idx + 1}`,
    prompt,
    options,
    allowMultiple,
  };
}

/**
 * Coerce the model's `ask_question` arguments into a typed request. Tolerant of
 * snake/camel keys and a few synonyms; drops malformed questions. Returns `null`
 * when there is nothing answerable.
 */
export function normalizeAskQuestionArgs(
  args: Record<string, unknown>,
): AskQuestionRequest | null {
  const rawList = args.questions ?? args.items ?? args.prompts;
  const list = Array.isArray(rawList) ? rawList : [];
  const questions: AskQuestionItem[] = [];
  list.forEach((q, i) => {
    const parsed = normalizeQuestion(q, i);
    if (parsed) questions.push(parsed);
  });
  if (questions.length === 0) return null;
  return { title: asString(args.title), questions };
}
