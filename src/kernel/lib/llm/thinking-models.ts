/**
 * Thinking model utilities.
 *
 * "Thinking mode" in some providers is represented by separate model variants
 * (for example deepseek-chat vs deepseek-reasoner).
 */

export interface ThinkingModelPair {
  currentModelIsThinking: boolean;
  nonThinkModel: string;
  thinkModel: string;
}

const THINKING_MODEL_REGEX = /(reasoner|reasoning|thinking)/i;
const NON_THINK_PREFERENCE_REGEX = /(chat|instruct|general)/i;
const THINK_PREFERENCE_REGEX = /(reasoner|reasoning|thinking)/i;

const getFamilyKey = (model: string): string => {
  const [family] = model.split(/[-_:]/);
  return family.toLowerCase();
};

export const isThinkingVariantModel = (model: string): boolean => {
  return THINKING_MODEL_REGEX.test(model);
};

const scoreCandidate = (
  currentModel: string,
  candidate: string,
  targetThinking: boolean
): number => {
  let score = 0;

  if (getFamilyKey(currentModel) === getFamilyKey(candidate)) {
    score += 10;
  }

  if (targetThinking && THINK_PREFERENCE_REGEX.test(candidate)) {
    score += 5;
  }

  if (!targetThinking && NON_THINK_PREFERENCE_REGEX.test(candidate)) {
    score += 5;
  }

  // Prefer shorter canonical names over deeply suffixed variants.
  score -= candidate.length * 0.001;
  return score;
};

const pickBestCandidate = (
  currentModel: string,
  candidates: string[],
  targetThinking: boolean
): string | null => {
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    return scoreCandidate(currentModel, b, targetThinking) - scoreCandidate(currentModel, a, targetThinking);
  });

  return sorted[0] ?? null;
};

/**
 * Resolve a think/non-think model pair from provider model list and current selection.
 * Returns null when no clear pair exists.
 */
export const resolveThinkingModelPair = (
  currentModel: string,
  providerModels: string[]
): ThinkingModelPair | null => {
  if (!currentModel || providerModels.length < 2) return null;

  const uniqueModels = Array.from(new Set(providerModels.filter(Boolean)));
  const thinkCandidates = uniqueModels.filter(isThinkingVariantModel);
  const nonThinkCandidates = uniqueModels.filter((model) => !isThinkingVariantModel(model));

  if (thinkCandidates.length === 0 || nonThinkCandidates.length === 0) {
    return null;
  }

  const currentModelIsThinking = isThinkingVariantModel(currentModel);

  const thinkModel = currentModelIsThinking
    ? currentModel
    : pickBestCandidate(currentModel, thinkCandidates, true);

  const nonThinkModel = currentModelIsThinking
    ? pickBestCandidate(currentModel, nonThinkCandidates, false)
    : currentModel;

  if (!thinkModel || !nonThinkModel || thinkModel === nonThinkModel) {
    return null;
  }

  return {
    thinkModel,
    nonThinkModel,
    currentModelIsThinking,
  };
};

