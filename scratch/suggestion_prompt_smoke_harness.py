# Suggestion-prompt smoke harness (disposable dev tool, not shipped).
#
# Replays the exact exchange from example.txt through the same raw-ChatML
# invocation used by the Rust pipeline. The prompt is optimized for a small
# instruction model: fixed reply roles, source-derived key terms, strict output
# formatting, compact few-shot examples, and lower-variance decoding.

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

EXE = Path(r"E:\llama-bin\llama-b10068-bin-win-cuda-13.3-x64\llama-completion.exe")
MODEL = Path(
    r"C:\Users\Alvan\Documents\ALL-GGUF-MODELS\Aurora-ide"
    r"\qwen-3.5-0.8b\Qwen3.5-0.8B-BF16.gguf"
)
EXAMPLE = Path(r"E:\VOID-EDITOR\Aurora-Agent-IDE\example.txt")

RUNS = 3
SEEDS = (101, 202, 303)

CONTEXT_SIZE = 12288
MAX_OUTPUT_TOKENS = 112
TIMEOUT_SECONDS = 240

# A 0.8B model is much more stable here than at temperature 0.7.
TEMPERATURE = 0.35
TOP_P = 0.85
TOP_K = 30

USER_MSG = "load surface and surface psychology compare against this webapp"

# Drop this exact prompt into the production Rust suggestion pipeline.
SUGGESTION_SYSTEM_PROMPT = """You generate exactly four one-tap NEXT messages for the USER of an AI coding assistant.

You receive:
USER MESSAGE: what the user asked
ASSISTANT REPLY: the assistant's latest response
KEY TERMS: exact concrete terms copied from the assistant reply

Write four useful messages the user could send next:

1. ACTION
Tell the assistant to perform the most useful concrete next action.
Start with a direct verb such as Fix, Add, Apply, Implement, Update, Handle, or Proceed.

2. DETAIL
Ask one short question about a specific finding, change, problem, number, file, test, or claim.
This line must end with a question mark.

3. VERIFY
Ask for concrete evidence or validation.
Start with Show, Verify, Test, Compare, Check, or Run.

4. ALTERNATIVE
Change priority, narrow scope, defer work, or choose another concrete item.
Start with Prioritize, Focus, Handle, Skip, Defer, or Start.

Special case:
If the assistant asks a yes-or-no question or offers extra work, line 1 should accept it concretely and line 4 should defer, reject, or redirect it concretely.

Rules:
- Speak as the user, never as the assistant.
- Use the same language as USER MESSAGE.
- Use only information found in ASSISTANT REPLY.
- Every line must refer to a concrete item from ASSISTANT REPLY.
- Prefer exact nouns and phrases from KEY TERMS.
- Each line must contain 3 to 8 words.
- Give four clearly different intents.
- Use direct commands or direct questions.
- Never write I will, We should, This is, or generic filler.
- Never write Sounds good, Continue, Tell me more, Thanks, or Okay.
- Do not answer the user's original request.
- Output only four numbered lines.
- No labels, explanations, quotes, markdown, or extra text.
- No ending punctuation except the question mark on line 2.

Example 1

USER MESSAGE:
the login form crashes on empty fields

ASSISTANT REPLY:
The validator assumed email was non-null. I added a guard and an empty-email test. All 42 tests pass. The signup form uses the same unsafe validator.

KEY TERMS:
validator, email, guard, empty-email test, 42 tests, signup form

OUTPUT:
1. Add the signup guard next
2. Which validator caused the crash?
3. Show the empty-email test
4. Defer signup until login verification

Example 2

USER MESSAGE:
audit checkout accessibility

ASSISTANT REPLY:
The audit found seven issues. Missing card-field labels and the coupon modal focus trap are critical. Three contrast failures are moderate.

KEY TERMS:
seven issues, card-field labels, coupon modal, focus trap, contrast failures

OUTPUT:
1. Fix the two critical issues
2. Which card-field labels are missing?
3. Show the coupon focus trap
4. Handle contrast failures after critical fixes

Required output:
1. ...
2. ...?
3. ...
4. ..."""

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "had", "has", "have",
    "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into",
    "is", "it", "its", "me", "my", "of", "on", "or", "our", "ours", "she",
    "should", "so", "that", "the", "their", "theirs", "them", "then", "there",
    "these", "they", "this", "those", "to", "too", "us", "was", "we", "were",
    "what", "when", "where", "which", "who", "why", "will", "with", "would",
    "you", "your", "yours",
}

BLOCKLIST = (
    "please provide",
    "great to hear",
    "sure, here",
    "here's ",
    "here is ",
    "sounds good",
    "tell me more",
    "thank you",
    "thanks",
    "okay",
)

QUESTION_WORDS = {
    "what", "which", "why", "how", "where", "when", "who",
    "can", "could", "did", "does", "do", "is", "are", "was", "were",
}

ACTION_WORDS = {
    "fix", "add", "apply", "implement", "update", "handle", "proceed",
    "remove", "change", "repair", "address",
}

VERIFY_WORDS = {
    "show", "verify", "test", "compare", "check", "run", "confirm", "prove",
}

ALTERNATIVE_WORDS = {
    "prioritize", "focus", "handle", "skip", "defer", "start", "narrow",
}


@dataclass(frozen=True)
class ChipScore:
    text: str
    word_count: int
    within_prompt_cap: bool
    grounded_terms: tuple[str, ...]
    grounded: bool
    intent: str


def fail(message: str) -> NoReturn:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def canonical_token(token: str) -> str:
    """Normalize only possessive 's; do not damage words ending in s."""
    return re.sub(r"'s$", "", token.lower())


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:[-'][a-z0-9]+)*", text.lower())


def content_terms(text: str) -> set[str]:
    result: set[str] = set()
    for token in tokenize(text):
        normalized = canonical_token(token)
        if (
            len(normalized) >= 3
            and normalized not in STOPWORDS
            and not normalized.isdigit()
        ):
            result.add(normalized)
    return result


def load_exchange() -> tuple[str, str]:
    if not EXAMPLE.is_file():
        fail(f"example file not found: {EXAMPLE}")

    raw = EXAMPLE.read_text(encoding="utf-8", errors="replace")
    start_marker = "auror agent replied was:"
    end_marker = "and the suggested replies show"

    if start_marker not in raw:
        fail(f"missing marker in example.txt: {start_marker!r}")

    assistant_reply = raw.split(start_marker, 1)[1]
    if end_marker in assistant_reply:
        assistant_reply = assistant_reply.split(end_marker, 1)[0]

    assistant_reply = assistant_reply.strip()
    if not assistant_reply:
        fail("assistant reply extracted from example.txt is empty")

    return USER_MSG, assistant_reply


def plain_prose(text: str) -> str:
    """Approximate the Rust plain_prose transform."""
    output: list[str] = []
    in_fence = False

    for line in text.splitlines():
        stripped = line.strip()

        if stripped.startswith("```"):
            in_fence = not in_fence
            continue

        if in_fence or not stripped or stripped.startswith("#"):
            continue

        # Remove markdown table rows while preserving ordinary prose with one pipe.
        if stripped.count("|") >= 2:
            continue

        stripped = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", stripped)
        stripped = stripped.replace("**", "").replace("__", "").replace("`", "")
        stripped = re.sub(r"\s+", " ", stripped).strip()

        if stripped:
            output.append(stripped)

    return " ".join(output)


def extract_key_terms(source: str, limit: int = 28) -> list[str]:
    """
    Give the 0.8B model a compact source vocabulary.

    Phrase patterns are placed first because phrases such as "newsletter form",
    "lack of reciprocity", "product tab", and "smart default" are much more useful
    than a generic bag of early words from a long audit reply.
    """
    lower_source = source.lower()

    phrase_patterns = (
        r"\b(?:critical|major|minor|moderate)\s+(?:issue|issues|problem|problems|finding|findings)\b",
        r"\b[a-z0-9-]+\s+(?:form|modal|tab|button|field|fields|test|tests|audit|default|failure|failures)\b",
        r"\b(?:lack of|missing|weak|failed|broken)\s+[a-z0-9-]+(?:\s+(?:of|in|on|for|with|and|or|the|a|an)?\s*[a-z0-9-]+){0,2}\b",
        r"\b(?:most|more|less)\s+(?:important|impactful|severe|useful)\b",
        r"\b\d+\s+(?:issue|issues|problem|problems|finding|findings|test|tests|failure|failures)\b",
    )

    phrases: list[str] = []
    for pattern in phrase_patterns:
        for match in re.finditer(pattern, lower_source):
            phrase = re.sub(r"\s+", " ", match.group(0)).strip()
            if phrase and phrase not in phrases:
                phrases.append(phrase)

    unique_tokens: list[str] = []
    seen_tokens: set[str] = set()
    for token in tokenize(source):
        normalized = canonical_token(token)
        if (
            len(normalized) < 3
            or normalized in STOPWORDS
            or normalized.isdigit()
            or normalized in seen_tokens
        ):
            continue
        seen_tokens.add(normalized)
        unique_tokens.append(token)

    # Sample across the full reply instead of taking only its beginning.
    sampled_tokens: list[str] = []
    if unique_tokens:
        count = min(limit, len(unique_tokens))
        if count == 1:
            sampled_tokens = [unique_tokens[0]]
        else:
            indexes = {
                round(index * (len(unique_tokens) - 1) / (count - 1))
                for index in range(count)
            }
            sampled_tokens = [unique_tokens[index] for index in sorted(indexes)]

    combined: list[str] = []
    seen_values: set[str] = set()

    for value in [*phrases[:12], *sampled_tokens]:
        normalized = value.lower()
        if normalized in seen_values:
            continue
        seen_values.add(normalized)
        combined.append(value)
        if len(combined) >= limit:
            break

    return combined


def build_exchange(
    user_message: str,
    assistant_reply: str,
) -> tuple[str, str, list[str]]:
    reply_prose = plain_prose(assistant_reply)
    key_terms = extract_key_terms(reply_prose)

    exchange = (
        "USER MESSAGE:\n"
        f"{user_message.strip()}\n\n"
        "ASSISTANT REPLY:\n"
        f"{reply_prose}\n\n"
        "KEY TERMS:\n"
        f"{', '.join(key_terms)}"
    )
    return exchange, reply_prose, key_terms


def build_chatml(system_prompt: str, exchange: str) -> str:
    return (
        f"<|im_start|>system\n{system_prompt}<|im_end|>\n"
        f"<|im_start|>user\n{exchange}<|im_end|>\n"
        f"<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )


def run_completion(system_prompt: str, exchange: str, seed: int) -> str:
    prompt = build_chatml(system_prompt, exchange)

    args = [
        str(EXE),
        "-m", str(MODEL),
        "-no-cnv",
        "-p", prompt,
        "--no-display-prompt",
        "--color", "off",
        "-n", str(MAX_OUTPUT_TOKENS),
        "-c", str(CONTEXT_SIZE),
        "-ngl", "99",
        "--no-warmup",
        "--temp", str(TEMPERATURE),
        "--top-p", str(TOP_P),
        "--top-k", str(TOP_K),
        "--seed", str(seed),
    ]

    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"__ERROR__ timeout after {TIMEOUT_SECONDS} seconds"
    except OSError as exc:
        return f"__ERROR__ failed to start llama-completion: {exc}"

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        return f"__ERROR__ exit {completed.returncode}: {stderr[-2000:]}"

    output = completed.stdout or ""
    for marker in ("[end of text]", "<|im_end|>", "</s>"):
        output = output.replace(marker, "")
    return output.strip()


def sanitize(line: str) -> str:
    text = line.strip()
    text = re.sub(r"^(?:\d{1,2}[.)]\s*|[-*+]\s*)", "", text)
    text = text.strip().strip("\"'“”‘’")
    text = re.sub(r"\s+", " ", text)
    return text.rstrip(".!;,").strip()


def extract_candidates(raw_output: str) -> list[str]:
    if raw_output.startswith("__ERROR__"):
        return []

    candidates: list[str] = []

    # Expected format: one numbered reply per line.
    for match in re.finditer(
        r"(?m)^\s*(?:[1-4][.)]|[-*+])\s*(.+?)\s*$",
        raw_output,
    ):
        value = sanitize(match.group(1))
        if value:
            candidates.append(value)

    # Small models occasionally place all numbered replies on one line.
    if len(candidates) < 4:
        inline_matches = re.findall(
            r"(?:^|\s)[1-4][.)]\s*(.+?)(?=(?:\s+[1-4][.)]\s)|$)",
            raw_output,
            flags=re.DOTALL,
        )
        for item in inline_matches:
            value = sanitize(item)
            if value and value not in candidates:
                candidates.append(value)

    # Last-resort parsing for unnumbered multiline output.
    if not candidates:
        for line in raw_output.splitlines():
            value = sanitize(line)
            if value:
                candidates.append(value)

    return candidates[:8]


def similarity(left_text: str, right_text: str) -> float:
    left = content_terms(left_text)
    right = content_terms(right_text)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def acceptable(text: str) -> bool:
    word_count = len(text.split())
    lowered = text.lower()
    return (
        1 <= word_count <= 12
        and not lowered.startswith(BLOCKLIST)
        and not any(marker in lowered for marker in ("assistant:", "user:", "output:"))
    )


def dedupe(candidates: Iterable[str]) -> list[str]:
    kept: list[str] = []

    for candidate in candidates:
        if not acceptable(candidate):
            continue
        if any(similarity(candidate, previous) >= 0.60 for previous in kept):
            continue
        kept.append(candidate)
        if len(kept) == 4:
            break

    return kept


def grounding_matches(
    chip: str,
    source: str,
    key_terms: list[str],
) -> tuple[str, ...]:
    matches = sorted(content_terms(chip) & content_terms(source))
    chip_lower = chip.lower()

    for key_term in key_terms:
        normalized = key_term.lower().strip()
        if " " in normalized and normalized in chip_lower and normalized not in matches:
            matches.append(normalized)

    return tuple(matches)


def classify_intent(text: str) -> str:
    tokens = tokenize(text)
    first = tokens[0] if tokens else ""

    if text.rstrip().endswith("?") or first in QUESTION_WORDS:
        return "detail"
    if first in VERIFY_WORDS:
        return "verify"
    if first in ACTION_WORDS:
        return "action"
    if first in ALTERNATIVE_WORDS:
        return "alternative"
    return "other"


def score_chip(
    text: str,
    source: str,
    key_terms: list[str],
) -> ChipScore:
    word_count = len(text.split())
    matches = grounding_matches(text, source, key_terms)

    return ChipScore(
        text=text,
        word_count=word_count,
        within_prompt_cap=3 <= word_count <= 8,
        grounded_terms=matches,
        grounded=len(matches) >= 1,
        intent=classify_intent(text),
    )


def evaluate_run(
    run_number: int,
    seed: int,
    raw_output: str,
    source: str,
    key_terms: list[str],
) -> tuple[int, int, int, int]:
    print(f"\n--- run {run_number} | seed {seed} ---")
    print("RAW:")
    print(raw_output or "(empty)")

    candidates = extract_candidates(raw_output)
    chips = dedupe(candidates)
    scores = [score_chip(chip, source, key_terms) for chip in chips]

    grounded_count = sum(score.grounded for score in scores)
    capped_count = sum(score.within_prompt_cap for score in scores)
    distinct_intents = len({score.intent for score in scores if score.intent != "other"})

    print(
        f"\nPARSED: {len(candidates)} | SURVIVED: {len(chips)} | "
        f"CAP: {capped_count}/{len(chips)} | "
        f"GROUNDED: {grounded_count}/{len(chips)} | "
        f"INTENTS: {distinct_intents}"
    )

    for index, score in enumerate(scores, start=1):
        cap_mark = "+" if score.within_prompt_cap else "-"
        ground_mark = "+" if score.grounded else "-"
        matched = ", ".join(score.grounded_terms) or "none"
        print(
            f"  {index}. [{cap_mark} cap] [{ground_mark} grounded] "
            f"[{score.intent}] {score.text}"
        )
        print(f"     words={score.word_count}; matches={matched}")

    return len(chips), capped_count, grounded_count, distinct_intents


def validate_paths() -> None:
    if not EXE.is_file():
        fail(f"llama executable not found: {EXE}")
    if not MODEL.is_file():
        fail(f"model not found: {MODEL}")


def main() -> int:
    validate_paths()

    user_message, assistant_reply = load_exchange()
    exchange, reply_prose, key_terms = build_exchange(user_message, assistant_reply)

    print(
        f"assistant reply: {len(assistant_reply)} chars raw -> "
        f"{len(reply_prose)} chars prose"
    )
    print(f"key terms: {', '.join(key_terms)}")
    print(
        f"decode: temp={TEMPERATURE}, top_p={TOP_P}, top_k={TOP_K}, "
        f"context={CONTEXT_SIZE}, max_tokens={MAX_OUTPUT_TOKENS}"
    )

    totals: list[tuple[int, int, int, int]] = []

    for run_index in range(RUNS):
        seed = SEEDS[run_index % len(SEEDS)]
        raw_output = run_completion(SUGGESTION_SYSTEM_PROMPT, exchange, seed)
        totals.append(
            evaluate_run(
                run_number=run_index + 1,
                seed=seed,
                raw_output=raw_output,
                source=reply_prose,
                key_terms=key_terms,
            )
        )

    avg_chips = sum(item[0] for item in totals) / len(totals)
    avg_capped = sum(item[1] for item in totals) / len(totals)
    avg_grounded = sum(item[2] for item in totals) / len(totals)
    avg_intents = sum(item[3] for item in totals) / len(totals)

    print("\n" + "=" * 72)
    print("FINAL SCORE")
    print("=" * 72)
    print(f"average surviving chips : {avg_chips:.2f}/4")
    print(f"average 3-8 word chips  : {avg_capped:.2f}/4")
    print(f"average grounded chips  : {avg_grounded:.2f}/4")
    print(f"average distinct intents: {avg_intents:.2f}/4")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
