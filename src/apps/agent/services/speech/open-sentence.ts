/**
 * Phonon's open sentence, kept whole.
 *
 * CrispASR re-reads only the last 30 seconds of the open sentence on each
 * step. A sentence that runs longer than that starts coming back without its
 * beginning: "Open the settings file and ... then" becomes "file and ... then
 * run". Shown as-is, the start would vanish from the composer while the user
 * is still talking. A pause ends the sentence long before that in normal
 * speech, so this only matters for someone who talks without stopping.
 *
 * The fix: when a long sentence comes back with a different first word, find
 * where its first few words sit in what was shown, and keep everything before
 * that point.
 */

/** Words compared when finding where the new text starts in the old. */
const ANCHOR_WORDS = 3;

/**
 * Below this many words the window cannot have slid yet (30 s is 60-80 words
 * of speech), so a changed first word is the model correcting itself, which
 * must win. In testing it rewrote "Ye Hey" to "Hey" in the first second.
 */
const MIN_WORDS_BEFORE_SLIDE = 50;

const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function mergeOpenSentence(previous: string, next: string): string {
  const nextText = next.trim();
  const prevWords = previous.trim().split(/\s+/).filter(Boolean);
  const nextWords = nextText.split(/\s+/).filter(Boolean);

  if (prevWords.length < MIN_WORDS_BEFORE_SLIDE || nextWords.length < ANCHOR_WORDS) {
    return nextText;
  }
  // Same start: the sentence just grew.
  if (normalize(prevWords[0]) === normalize(nextWords[0])) return nextText;

  const anchor = nextWords.slice(0, ANCHOR_WORDS).map(normalize);
  if (anchor.some((word) => !word)) return nextText;

  for (let at = 1; at + ANCHOR_WORDS <= prevWords.length; at += 1) {
    if (anchor.every((word, i) => word === normalize(prevWords[at + i]))) {
      return [...prevWords.slice(0, at), ...nextWords].join(" ");
    }
  }
  return nextText;
}
