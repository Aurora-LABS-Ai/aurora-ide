# Suggestion-prompt smoke harness (disposable dev tool, not shipped).
#
# Replays the EXACT exchange from example.txt (user message + full assistant
# audit reply) through the same raw-ChatML invocation the Rust pipeline uses,
# across 3 candidate system prompts, and scores each on: parsed chip count,
# filter survival, word-cap compliance, and grounding (content-word overlap
# with the assistant reply). Context bumped to 12288 so the FULL reply fits —
# no tail clamp — leveraging the model's 262k native window.

import re
import subprocess
import sys

EXE = r"E:\llama-bin\llama-b10068-bin-win-cuda-13.3-x64\llama-completion.exe"
MODEL = r"C:\Users\Alvan\Documents\ALL-GGUF-MODELS\Aurora-ide\qwen-3.5-0.8b\Qwen3.5-0.8B-BF16.gguf"
EXAMPLE = r"E:\VOID-EDITOR\Aurora-Agent-IDE\example.txt"

RUNS_PER_PROMPT = 3  # sampling at temp 0.7 varies; measure stability too

# ── The exact exchange from example.txt ──────────────────────────────────────
raw = open(EXAMPLE, encoding="utf-8").read()
USER_MSG = "load surface and surface psychology compare against this webapp"
# Assistant reply = everything between "auror agent replied was:" and the
# trailing note about what the live UI showed.
body = raw.split("auror agent replied was:", 1)[1]
body = body.split("and the suggested replies show", 1)[0].strip()
ASSISTANT_REPLY = body


def plain_prose(text: str) -> str:
    """Mirror of the Rust plain_prose: drop tables/fences/headings/emphasis."""
    out, in_fence = [], False
    for line in text.splitlines():
        t = line.strip()
        if t.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not t or "|" in t or t.startswith("#"):
            continue
        t = re.sub(r"^[-*] ", "", t).replace("*", "").replace("`", "")
        if t.strip():
            out.append(t.strip())
    return " ".join(out)


# ── Candidate system prompts ─────────────────────────────────────────────────
P1_CURRENT = (
    "You are role-playing as the USER in a conversation with a coding assistant. "
    "Below you will see the message you sent and the assistant's reply. Put yourself "
    "in the user's place: remember what you asked for, read what the assistant "
    "answered, and think about what you would naturally send next. Write exactly 3 "
    "different short next replies from the user, each with a different intent: one "
    "that agrees or accepts, one that asks about a detail, one that requests "
    "something different or more. If the assistant asked a yes/no question, one "
    "reply must accept it and one must decline or postpone it. Each reply at most "
    "8 words. Number them 1. 2. 3. and output only the numbered replies, nothing else."
)

P2_PLAYBOOK = (
    "You are role-playing as the USER (a software developer) in a chat with their AI "
    "coding assistant inside an IDE. Your job: write the user's possible NEXT messages, "
    "which appear as one-tap reply buttons under the chat.\n\n"
    "You will see the message the user sent and the assistant's reply. First silently "
    "decide which situation the reply is:\n"
    "- The assistant FINISHED a task -> replies like: confirm it works, ask to verify, request the next task.\n"
    "- The assistant ASKED a question -> replies like: accept, decline or postpone, ask for detail before deciding.\n"
    "- The assistant REPORTED FINDINGS or a plan -> replies like: tell it to proceed with the most important part, "
    "ask about one specific finding, narrow or reprioritize the scope.\n"
    "- The assistant HIT a problem -> replies like: ask for the cause, request a fix, ask for options.\n\n"
    "Rules for every reply:\n"
    "- Written in the user's voice, as a message the user would actually send.\n"
    "- At most 8 words.\n"
    "- Each reply must mention or clearly point at something CONCRETE from the assistant's reply, "
    "not generic filler like 'sounds good' or 'tell me more'.\n"
    "- All 4 replies must have clearly different intents.\n\n"
    "Always output exactly 4 replies, numbered 1. to 4., one per line, nothing else."
)

P3_FEWSHOT = (
    "You write one-tap reply suggestions for a developer chatting with an AI coding "
    "assistant. Given the developer's message and the assistant's reply, produce the "
    "4 most useful messages the developer might tap next. Short (max 8 words), in the "
    "developer's voice, each a different intent, each anchored to something specific "
    "in the assistant's reply. Always exactly 4, numbered, nothing else.\n\n"
    "Example A\n"
    "Developer's message: the login form crashes when i submit empty fields\n"
    "Assistant's reply: Found it - the validator assumed a non-null email. I added a guard and a test; "
    "all 42 tests pass. Want me to also add guards to the signup form?\n"
    "Suggestions:\n"
    "1. Yes, guard the signup form too\n"
    "2. Not now, show me the diff first\n"
    "3. Which test covers the empty email case?\n"
    "4. Run the full suite once more\n\n"
    "Example B\n"
    "Developer's message: audit the checkout flow for accessibility problems\n"
    "Assistant's reply: The audit found 7 issues: 2 critical (missing labels on the card fields, focus trap "
    "in the coupon modal), 3 moderate contrast failures, and 2 minor ARIA gaps. The critical ones block "
    "screen-reader checkout entirely.\n"
    "Suggestions:\n"
    "1. Fix the two critical issues first\n"
    "2. Show me the coupon modal focus trap\n"
    "3. Which elements fail contrast?\n"
    "4. Give me the full issue list\n"
)

PROMPTS = {"P1-current": P1_CURRENT, "P2-playbook": P2_PLAYBOOK, "P3-fewshot": P3_FEWSHOT}

# ── Invocation identical to Rust run_completion ──────────────────────────────
def run(system: str, exchange: str) -> str:
    prompt = (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{exchange}<|im_end|>\n"
        f"<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )
    args = [
        EXE, "-m", MODEL, "-no-cnv", "-p", prompt,
        "--no-display-prompt", "--color", "off",
        "-n", "160", "-c", "12288", "-ngl", "99", "--no-warmup",
        "--temp", "0.7", "--top-p", "0.8", "--top-k", "20",
    ]
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", timeout=180)
    return (r.stdout or "").replace("[end of text]", "").strip()


# ── Mirror of the Rust filters ───────────────────────────────────────────────
BLOCKLIST = ("please provide", "great to hear", "sure, here", "here's ", "here is ")

def sanitize(line: str) -> str:
    s = line.strip()
    s = re.sub(r"^(\d{1,2}\.\s*|[-*]\s*)", "", s)
    return s.strip().strip('"').rstrip(".!;,").strip()

def acceptable(s: str) -> bool:
    w = len(s.split())
    return 1 <= w <= 12 and not s.lower().startswith(BLOCKLIST)

def overlap(a: str, b: str) -> bool:
    sa, sb = set(a.lower().split()), set(b.lower().split())
    return bool(sa) and bool(sb) and len(sa & sb) * 10 >= min(len(sa), len(sb)) * 6

STOPWORDS = set("the a an of to in on for and or is are do does can you i my we what which how it this that with about me your".split())

def grounded(reply: str, source: str) -> bool:
    content = {w for w in re.findall(r"[a-z0-9']+", reply.lower()) if w not in STOPWORDS}
    src = set(re.findall(r"[a-z0-9']+", source.lower()))
    return len(content & src) >= 2


def evaluate(name: str, system: str, exchange: str, source: str) -> None:
    print(f"\n{'=' * 70}\n{name}\n{'=' * 70}")
    totals = []
    for run_index in range(RUNS_PER_PROMPT):
        raw_out = run(system, exchange)
        chips = []
        for line in raw_out.splitlines():
            s = sanitize(line)
            if not s or not acceptable(s):
                continue
            if any(overlap(prev, s) for prev in chips):
                continue
            chips.append(s)
            if len(chips) == 4:
                break
        g = sum(1 for c in chips if grounded(c, source))
        totals.append((len(chips), g))
        print(f"\n--- run {run_index + 1}: {len(chips)} chips, {g} grounded ---")
        print("RAW:", " / ".join(raw_out.splitlines()) or "(empty)")
        for c in chips:
            mark = "+" if grounded(c, source) else "-"
            print(f"  [{mark}] {c}")
    avg_chips = sum(t[0] for t in totals) / len(totals)
    avg_ground = sum(t[1] for t in totals) / len(totals)
    print(f"\nSCORE {name}: avg chips {avg_chips:.1f}/4, avg grounded {avg_ground:.1f}")


def main() -> None:
    reply_prose = plain_prose(ASSISTANT_REPLY)
    print(f"assistant reply: {len(ASSISTANT_REPLY)} chars raw -> {len(reply_prose)} chars prose")
    exchange = f"My message:\n{USER_MSG}\n\nAssistant's reply:\n{reply_prose}"
    for name, system in PROMPTS.items():
        evaluate(name, system, exchange, reply_prose)


if __name__ == "__main__":
    sys.exit(main())
