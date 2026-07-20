# Suggestion-prompt smoke harness (disposable dev tool, not shipped).
#
# Default terminal output is intentionally clean:
#   - runs multiple samples internally
#   - selects the strongest result
#   - prints only the four suggestions in color
#
# Use:
#   py suggestion_prompt_smoke_harness.py
#   py suggestion_prompt_smoke_harness.py --all-runs
#   py suggestion_prompt_smoke_harness.py --debug

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
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

# Lower variance works better for a 0.8B model.
TEMPERATURE = 0.25
TOP_P = 0.82
TOP_K = 24

USER_MSG = "load surface and surface psychology compare against this webapp"

SUGGESTION_SYSTEM_PROMPT = """You generate four one-tap NEXT messages for the USER of an AI coding assistant.

You receive:
USER MESSAGE: what the user asked
ASSISTANT REPLY: the assistant's latest response
KEY TERMS: concrete terms copied from the assistant reply

Write exactly four useful messages:

1. ACTION
Tell the assistant to perform the best concrete next action.
Start with Fix, Add, Apply, Implement, Update, Handle, or Proceed.

2. DETAIL
Ask about one specific finding, problem, number, file, test, or claim.
This line must end with a question mark.

3. VERIFY
Request concrete proof, inspection, comparison, or validation.
Start with Show, Verify, Test, Compare, Check, or Run.

4. ALTERNATIVE
Change priority, narrow scope, defer work, or choose another item.
Start with Prioritize, Focus, Handle, Skip, Defer, or Start.

Special case:
If the assistant asks a yes-or-no question or offers extra work, line 1
must accept it concretely and line 4 must defer, reject, or redirect it.

STRICT RULES:
- Speak as the user, never as the assistant.
- Use the same language as USER MESSAGE.
- Use only information found in ASSISTANT REPLY.
- Anchor every line to a concrete item from ASSISTANT REPLY.
- Prefer exact nouns and phrases from KEY TERMS.
- Every line must contain 3 to 8 words.
- Silently count the words before answering.
- Rewrite any line longer than 8 words.
- Give four clearly different intents.
- Use direct commands or direct questions.
- Never begin with I will, We should, This is, Okay, Thanks, or Sounds good.
- Never answer the original user request.
- Output only four numbered lines.
- No labels, explanations, quotes, markdown, or extra text.
- No ending punctuation except the question mark on line 2.

Example 1

USER MESSAGE:
the login form crashes on empty fields

ASSISTANT REPLY:
The validator assumed email was non-null. I added a guard and an
empty-email test. All 42 tests pass. The signup form uses the same validator.

KEY TERMS:
validator, email, guard, empty-email test, 42 tests, signup form

OUTPUT:
1. Add the signup guard
2. Which validator caused the crash?
3. Show the empty-email test
4. Defer signup until login verification

Example 2

USER MESSAGE:
audit checkout accessibility

ASSISTANT REPLY:
The audit found seven issues. Missing card-field labels and the coupon modal
focus trap are critical. Three contrast failures are moderate.

KEY TERMS:
seven issues, card-field labels, coupon modal, focus trap, contrast failures

OUTPUT:
1. Fix both critical issues
2. Which card-field labels are missing?
3. Show the coupon focus trap
4. Handle contrast failures afterward

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


# ── Terminal colors ───────────────────────────────────────────────────────────

class Color:
    RESET = "\x1b[0m"
    BOLD = "\x1b[1m"
    DIM = "\x1b[2m"

    RED = "\x1b[91m"
    GREEN = "\x1b[92m"
    YELLOW = "\x1b[93m"
    BLUE = "\x1b[94m"
    MAGENTA = "\x1b[95m"
    CYAN = "\x1b[96m"
    WHITE = "\x1b[97m"
    GRAY = "\x1b[90m"


def color_enabled() -> bool:
    return (
        sys.stdout.isatty()
        and os.environ.get("NO_COLOR") is None
        and os.environ.get("TERM", "").lower() != "dumb"
    )


USE_COLOR = color_enabled()


def paint(text: str, *styles: str) -> str:
    if not USE_COLOR:
        return text
    return "".join(styles) + text + Color.RESET


# ── Data models ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Chip:
    text: str
    word_count: int
    grounded_terms: tuple[str, ...]
    grounded: bool
    within_cap: bool
    intent: str


@dataclass(frozen=True)
class RunResult:
    run_number: int
    seed: int
    raw_output: str
    candidates: tuple[str, ...]
    chips: tuple[Chip, ...]
    score: tuple[int, int, int, int, int]


# ── Input and prompt building ─────────────────────────────────────────────────

def fail(message: str) -> NoReturn:
    print(paint(f"ERROR: {message}", Color.RED, Color.BOLD), file=sys.stderr)
    raise SystemExit(1)


def canonical_token(token: str) -> str:
    return re.sub(r"'s$", "", token.lower())


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:[-'][a-z0-9]+)*", text.lower())


def content_terms(text: str) -> set[str]:
    terms: set[str] = set()

    for token in tokenize(text):
        normalized = canonical_token(token)
        if (
            len(normalized) >= 3
            and normalized not in STOPWORDS
            and not normalized.isdigit()
        ):
            terms.add(normalized)

    return terms


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
    output: list[str] = []
    in_fence = False

    for line in text.splitlines():
        stripped = line.strip()

        if stripped.startswith("```"):
            in_fence = not in_fence
            continue

        if in_fence or not stripped or stripped.startswith("#"):
            continue

        # Remove Markdown table rows, but preserve normal prose containing one pipe.
        if stripped.count("|") >= 2:
            continue

        stripped = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", stripped)
        stripped = stripped.replace("**", "").replace("__", "").replace("`", "")
        stripped = re.sub(r"\s+", " ", stripped).strip()

        if stripped:
            output.append(stripped)

    return " ".join(output)


def extract_key_terms(source: str, limit: int = 28) -> list[str]:
    lower_source = source.lower()

    phrase_patterns = (
        r"\b(?:critical|major|minor|moderate)\s+"
        r"(?:issue|issues|problem|problems|finding|findings)\b",
        r"\b[a-z0-9-]+\s+"
        r"(?:form|modal|tab|button|field|fields|test|tests|audit|default|failure|failures)\b",
        r"\b(?:lack of|missing|weak|failed|broken)\s+"
        r"[a-z0-9-]+(?:\s+(?:of|in|on|for|with|and|or|the|a|an)?\s*[a-z0-9-]+){0,2}\b",
        r"\b(?:most|more|less)\s+(?:important|impactful|severe|useful)\b",
        r"\b\d+\s+"
        r"(?:issue|issues|problem|problems|finding|findings|test|tests|failure|failures)\b",
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


# ── Model execution ───────────────────────────────────────────────────────────

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


# ── Parsing and scoring ───────────────────────────────────────────────────────

def sanitize(line: str) -> str:
    text = line.strip()
    text = re.sub(r"^(?:\d{1,2}[.)]\s*|[-*+]\s*)", "", text)
    text = text.strip().strip("\"'“”‘’")
    text = re.sub(r"\s+", " ", text)

    # Keep a question mark, remove other ending punctuation.
    if text.endswith("?"):
        return text
    return text.rstrip(".!;,").strip()


def extract_candidates(raw_output: str) -> list[str]:
    if raw_output.startswith("__ERROR__"):
        return []

    candidates: list[str] = []

    # Normal multiline numbered output.
    for match in re.finditer(
        r"(?m)^\s*(?:[1-4][.)]|[-*+])\s*(.+?)\s*$",
        raw_output,
    ):
        value = sanitize(match.group(1))
        if value:
            candidates.append(value)

    # Fallback when all four numbered suggestions are on one line.
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

    # Final fallback for unnumbered lines.
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
        1 <= word_count <= 16
        and not lowered.startswith(BLOCKLIST)
        and not any(marker in lowered for marker in ("assistant:", "user:", "output:"))
    )


def dedupe(candidates: list[str]) -> list[str]:
    kept: list[str] = []

    for candidate in candidates:
        if not acceptable(candidate):
            continue

        # Higher threshold prevents valid related suggestions from being discarded.
        if any(similarity(candidate, previous) >= 0.78 for previous in kept):
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


def make_chip(
    text: str,
    source: str,
    key_terms: list[str],
) -> Chip:
    word_count = len(text.split())
    matches = grounding_matches(text, source, key_terms)

    return Chip(
        text=text,
        word_count=word_count,
        grounded_terms=matches,
        grounded=len(matches) >= 1,
        within_cap=3 <= word_count <= 8,
        intent=classify_intent(text),
    )


def build_run_result(
    run_number: int,
    seed: int,
    raw_output: str,
    source: str,
    key_terms: list[str],
) -> RunResult:
    candidates = extract_candidates(raw_output)
    selected = dedupe(candidates)
    chips = tuple(make_chip(text, source, key_terms) for text in selected)

    exact_four = int(len(chips) == 4)
    capped = sum(chip.within_cap for chip in chips)
    grounded = sum(chip.grounded for chip in chips)
    distinct_intents = len({chip.intent for chip in chips if chip.intent != "other"})
    total_words = sum(chip.word_count for chip in chips)

    # Tuple comparison chooses the strongest run lexicographically.
    score = (
        exact_four,
        grounded,
        capped,
        distinct_intents,
        -total_words,
    )

    return RunResult(
        run_number=run_number,
        seed=seed,
        raw_output=raw_output,
        candidates=tuple(candidates),
        chips=chips,
        score=score,
    )


# ── Clean colored output ──────────────────────────────────────────────────────

INTENT_LABELS = {
    "action": "ACTION",
    "detail": "QUESTION",
    "verify": "VERIFY",
    "alternative": "ALTERNATIVE",
    "other": "SUGGESTION",
}

INTENT_COLORS = {
    "action": Color.GREEN,
    "detail": Color.CYAN,
    "verify": Color.MAGENTA,
    "alternative": Color.YELLOW,
    "other": Color.WHITE,
}


def print_header(title: str) -> None:
    width = 72
    print()
    print(paint("╭" + "─" * (width - 2) + "╮", Color.BLUE))
    print(
        paint("│", Color.BLUE)
        + paint(f" {title}".ljust(width - 2), Color.BOLD, Color.WHITE)
        + paint("│", Color.BLUE)
    )
    print(paint("╰" + "─" * (width - 2) + "╯", Color.BLUE))


def print_suggestions(result: RunResult, title: str = "AURORA REPLY SUGGESTIONS") -> None:
    print_header(title)

    if not result.chips:
        print(paint("No suggestions could be parsed.", Color.RED, Color.BOLD))
        print()
        return

    for index, chip in enumerate(result.chips, start=1):
        color = INTENT_COLORS.get(chip.intent, Color.WHITE)
        label = INTENT_LABELS.get(chip.intent, "SUGGESTION")

        number = paint(f"{index}", color, Color.BOLD)
        badge = paint(f"{label:<11}", color, Color.BOLD)
        text = paint(chip.text, Color.WHITE, Color.BOLD)

        print(f"  {number}  {badge}  {text}")

    if len(result.chips) < 4:
        missing = 4 - len(result.chips)
        print()
        print(
            paint(
                f"  Warning: model returned only {len(result.chips)} valid "
                f"suggestions; {missing} missing.",
                Color.RED,
            )
        )

    print()
    print(
        paint(
            f"  Selected run {result.run_number}  •  seed {result.seed}",
            Color.GRAY,
            Color.DIM,
        )
    )
    print()


def print_debug_result(result: RunResult) -> None:
    print(paint(f"Run {result.run_number} | seed {result.seed}", Color.BLUE, Color.BOLD))
    print(paint("RAW OUTPUT", Color.GRAY, Color.BOLD))
    print(result.raw_output or "(empty)")
    print()

    grounded = sum(chip.grounded for chip in result.chips)
    capped = sum(chip.within_cap for chip in result.chips)
    intents = len({chip.intent for chip in result.chips if chip.intent != "other"})

    print(
        f"parsed={len(result.candidates)}  "
        f"survived={len(result.chips)}  "
        f"grounded={grounded}/{len(result.chips)}  "
        f"within_cap={capped}/{len(result.chips)}  "
        f"intents={intents}"
    )

    for index, chip in enumerate(result.chips, start=1):
        matches = ", ".join(chip.grounded_terms) or "none"
        print(
            f"  {index}. {chip.text}\n"
            f"     intent={chip.intent}, words={chip.word_count}, "
            f"grounded={chip.grounded}, matches={matches}"
        )

    print()


# ── CLI and main ──────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate and score Aurora reply suggestions."
    )
    parser.add_argument(
        "--all-runs",
        action="store_true",
        help="Show the four colored suggestions from every sampled run.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Show raw model output and scoring diagnostics.",
    )
    return parser.parse_args()


def validate_paths() -> None:
    if not EXE.is_file():
        fail(f"llama executable not found: {EXE}")

    if not MODEL.is_file():
        fail(f"model not found: {MODEL}")


def main() -> int:
    args = parse_args()
    validate_paths()

    user_message, assistant_reply = load_exchange()
    exchange, reply_prose, key_terms = build_exchange(
        user_message,
        assistant_reply,
    )

    if args.debug:
        print(
            paint(
                f"Assistant reply: {len(assistant_reply)} raw chars -> "
                f"{len(reply_prose)} prose chars",
                Color.GRAY,
            )
        )
        print(paint(f"Key terms: {', '.join(key_terms)}", Color.GRAY))
        print(
            paint(
                f"Decode: temp={TEMPERATURE}, top_p={TOP_P}, top_k={TOP_K}, "
                f"context={CONTEXT_SIZE}, max_tokens={MAX_OUTPUT_TOKENS}",
                Color.GRAY,
            )
        )
        print()

    results: list[RunResult] = []

    for run_index in range(RUNS):
        seed = SEEDS[run_index % len(SEEDS)]

        if not args.debug and not args.all_runs:
            status = f"Generating suggestions {run_index + 1}/{RUNS}..."
            print(
                "\r" + paint(status.ljust(45), Color.GRAY, Color.DIM),
                end="",
                flush=True,
            )

        raw_output = run_completion(
            SUGGESTION_SYSTEM_PROMPT,
            exchange,
            seed,
        )

        result = build_run_result(
            run_number=run_index + 1,
            seed=seed,
            raw_output=raw_output,
            source=reply_prose,
            key_terms=key_terms,
        )
        results.append(result)

        if args.debug:
            print_debug_result(result)
        elif args.all_runs:
            print_suggestions(
                result,
                title=f"AURORA SUGGESTIONS — RUN {result.run_number}",
            )

    if not results:
        fail("no model runs completed")

    best = max(results, key=lambda item: item.score)

    if not args.debug and not args.all_runs:
        print("\r" + " " * 60 + "\r", end="", flush=True)
        print_suggestions(best)

    if args.debug:
        print_suggestions(best, title="BEST AURORA REPLY SUGGESTIONS")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
