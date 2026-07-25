# Starter-prompt smoke harness (disposable dev tool, not shipped).
#
# Sibling of smoke_suggest.py, for the EmptyState starter prompts planned in
# DOCS/agent-window-starter-prompts.md. Uses AURORA IDE ITSELF as the project,
# with real context: package.json, top-level dirs, git branch + commits, README,
# and the real thread titles from <LOCALAPPDATA>/AuroraIDE/sessions/*.meta.json
# scoped to this workspace.
#
# Same raw-ChatML invocation as the Rust pipeline. Scores each candidate system
# prompt on: parsed count, word-cap compliance, dedup survival, GROUNDING
# (content-word overlap with real project context) and PATH VALIDITY (every
# path-looking token must actually exist on disk — a starter naming a file that
# isn't there is the failure mode that discredits the whole row).
#
# It also answers the open design question: can a 0.8B model reliably emit a
# STRUCTURED "label | prompt" line, or should we only ask for the prompt and
# derive the label/category ourselves?

import json
import os
import re
import subprocess
import sys
from pathlib import Path

EXE = r"E:\llama-bin\llama-b10068-bin-win-cuda-13.3-x64\llama-completion.exe"
MODEL = r"C:\Users\Alvan\Documents\ALL-GGUF-MODELS\Aurora-ide\qwen-3.5-0.8b\Qwen3.5-0.8B-BF16.gguf"

# Defaults to Aurora IDE itself. Pass a path to test another project — useful
# because this repo has ZERO agent chats against it (all 289 sessions belong to
# other workspaces), so it exercises the COLD-START path. Point it at e.g.
# E:\VOID-EDITOR\aurora-testing (32 chats) to exercise the warm path.
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\VOID-EDITOR\Aurora-Agent-IDE")
SESSIONS = Path(os.environ["LOCALAPPDATA"]) / "AuroraIDE" / "sessions"

RUNS_PER_PROMPT = 3
SKIP_DIRS = {"node_modules", "dist", "build", ".git", "graphify-out", "vendor", "__pycache__"}

LABEL_MAX_WORDS = 5
PROMPT_MAX_WORDS = 16


# ── Real project context ─────────────────────────────────────────────────────
def git(*args: str) -> str:
    try:
        r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True,
                           text=True, encoding="utf-8", timeout=20)
        return (r.stdout or "").strip()
    except Exception:
        return ""


def top_level_dirs() -> list[str]:
    return sorted(p.name for p in ROOT.iterdir()
                  if p.is_dir() and p.name not in SKIP_DIRS and not p.name.startswith("."))


def package_facts() -> tuple[str, list[str]]:
    try:
        pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    except Exception:
        return "", []
    return pkg.get("name", ""), sorted(pkg.get("scripts", {}).keys())


def recent_thread_titles(limit: int = 8) -> list[str]:
    """Real titles from this workspace's sessions, newest first.

    NB: the sidecar is serialized camelCase (`workspaceRoot`, `updatedAt`) even
    though the Rust struct fields are snake_case — there is a `rename_all` on
    SessionMetadata. Reading snake_case here silently yields ZERO titles, which
    looks like "no history" rather than a bug. Both spellings are accepted.
    """
    rows = []
    if not SESSIONS.is_dir():
        return rows
    want = str(ROOT).lower().replace("/", "\\").rstrip("\\")
    for f in SESSIONS.glob("*.meta.json"):
        try:
            m = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        raw_ws = m.get("workspaceRoot") or m.get("workspace_root") or ""
        ws = raw_ws.lower().replace("/", "\\").rstrip("\\")
        if ws != want:
            continue
        if m.get("archivedAt") or m.get("archived_at"):
            continue  # archived means done — poor signal for "what's next"
        title = (m.get("title") or "").strip()
        if title and title != "New Chat":
            rows.append((m.get("updatedAt") or m.get("updated_at") or "", title))
    rows.sort(reverse=True)
    seen, out = set(), []
    for _, t in rows:
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
        if len(out) == limit:
            break
    return out


BADGE_RE = re.compile(r"!?\[[^\]]*\]\([^)]*\)")   # images + links
HTML_RE = re.compile(r"<[^>]+>")

def readme_head(chars: int = 700) -> str:
    """First real prose of the README.

    Badge rows, shields.io URLs and centering <div>s are stripped: left in, they
    dominate the context AND poison the grounding vocabulary with words like
    'img', 'shields', 'badge', so junk starters would score as 'grounded'.
    """
    for name in ("README.md", "CLAUDE.md"):
        p = ROOT / name
        if not p.is_file():
            continue
        out, in_fence = [], False
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            t = line.strip()
            if t.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence or not t or "|" in t or t.startswith("#") or t.startswith(">"):
                continue
            t = HTML_RE.sub("", BADGE_RE.sub("", t)).replace("*", "").replace("`", "")
            t = re.sub(r"\s+", " ", t).strip()
            if len(t) < 25 or "http" in t:
                continue          # nav crumbs, stray badge text, bare URLs
            out.append(t)
            if sum(len(x) for x in out) > chars:
                break
        if out:
            return " ".join(out)[:chars]
    return ""


def file_tree(max_depth: int = 4, cap: int = 1200) -> list[str]:
    """Real paths, depth-limited. The single most valuable rich-context block:
    a model that can SEE the tree has no reason to invent `src/src-tauri/src/main.rs`."""
    out = []
    root_len = len(ROOT.parts)
    for dirpath, dirnames, filenames in os.walk(ROOT):
        p = Path(dirpath)
        depth = len(p.parts) - root_len
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIRS and not d.startswith("."))
        if depth >= max_depth:
            dirnames[:] = []
        rel = "/".join(p.parts[root_len:]) or "."
        keep = sorted(f for f in filenames if not f.startswith("."))[:60]
        if keep:
            out.append(f"{rel}/  " + " ".join(keep))
        if len(out) >= cap:
            break
    return out


def git_status_files(limit: int = 40) -> list[str]:
    rows = [l.strip() for l in git("status", "--porcelain").splitlines() if l.strip()]
    return rows[:limit]


def build_rich_context() -> tuple[str, dict]:
    """~10k-token context. The model's native window is ~262k, so the lean
    ~1k-char context was leaving almost everything on the table."""
    name, scripts = package_facts()
    branch = git("branch", "--show-current")
    commits = [c for c in git("log", "-40", "--format=%s").splitlines() if c.strip()]
    titles = recent_thread_titles(limit=40)
    readme = readme_head(9000)
    tree = file_tree()
    dirty = git_status_files()
    dirs = top_level_dirs()

    lines = [f"Project: {name or ROOT.name}"]
    if readme:
        lines.append(f"About this project:\n{readme}")
    lines.append(f"Top-level folders: {', '.join(dirs)}")
    if scripts:
        lines.append(f"Package scripts: {', '.join(scripts)}")
    if branch:
        lines.append(f"Current git branch: {branch}")
    if dirty:
        lines.append("Files with uncommitted changes right now:\n"
                     + "\n".join(f"- {d}" for d in dirty))
    if commits:
        lines.append("Recent commits (newest first):\n"
                     + "\n".join(f"- {c}" for c in commits))
    if titles:
        lines.append("The developer's past chats in this project (already done — "
                     "do NOT repeat these):\n" + "\n".join(f"- {t}" for t in titles))
    if tree:
        lines.append("Project files (real paths — only ever refer to these):\n"
                     + "\n".join(tree))

    facts = {"dirs": dirs, "scripts": scripts, "branch": branch, "commits": commits,
             "titles": titles, "readme": readme, "name": name,
             "tree": tree, "dirty": dirty}
    return "\n\n".join(lines), facts


def build_context() -> tuple[str, dict]:
    name, scripts = package_facts()
    dirs = top_level_dirs()
    branch = git("branch", "--show-current")
    commits = [c for c in git("log", "-5", "--format=%s").splitlines() if c.strip()]
    titles = recent_thread_titles()
    readme = readme_head()

    lines = [f"Project: {name or ROOT.name}"]
    if readme:
        lines.append(f"About: {readme}")
    lines.append(f"Top-level folders: {', '.join(dirs)}")
    if scripts:
        lines.append(f"Package scripts: {', '.join(scripts)}")
    if branch:
        lines.append(f"Current git branch: {branch}")
    if commits:
        lines.append("Recent commits:\n" + "\n".join(f"- {c}" for c in commits))
    if titles:
        lines.append("The developer's recent chats in this project:\n"
                     + "\n".join(f"- {t}" for t in titles))
    facts = {"dirs": dirs, "scripts": scripts, "branch": branch,
             "commits": commits, "titles": titles, "readme": readme, "name": name}
    return "\n\n".join(lines), facts


# ── Candidate system prompts ─────────────────────────────────────────────────
S1_DIRECT = (
    "You write starter prompts for a developer opening an AI coding assistant on their "
    "project. You will see facts about the project. Write the 4 most useful first "
    "messages the developer might tap to begin. Each must be specific to THIS project — "
    "name a real folder, script, branch, or task from the facts. Never invent file paths "
    "that are not in the facts. Each at most 16 words, in the developer's voice. "
    "Always exactly 4, numbered 1. to 4., nothing else."
)

S2_PLAYBOOK = (
    "You write the starter prompts shown as one-tap buttons when a developer opens an AI "
    "coding assistant on their project.\n\n"
    "You will see facts about the project: folders, scripts, git branch, recent commits, "
    "and the developer's recent chats. First silently decide what this developer is in the "
    "middle of, then write 4 opening messages covering different intents:\n"
    "- one to UNDERSTAND part of the codebase\n"
    "- one to CONTINUE something recent (a branch, a commit, a recent chat)\n"
    "- one to FIX or investigate a problem\n"
    "- one to VERIFY (tests, build, lint)\n\n"
    "Rules for every prompt:\n"
    "- Specific to THIS project: name a real folder, script, branch, or recent topic.\n"
    "- Only use names that appear in the facts. Never invent a file path.\n"
    "- At most 16 words, written as the developer would type it.\n\n"
    "Always output exactly 4, numbered 1. to 4., one per line, nothing else."
)

S3_FEWSHOT_FIELDS = (
    "You write starter prompts for a developer opening an AI coding assistant on their "
    "project. Given facts about the project, output the 4 most useful opening messages.\n"
    # NB: the placeholder here MUST be a real digit. Writing "N. <label>" made the
    # model emit a literal "N." prefix on every line (see run log) — it copies the
    # format spec verbatim rather than interpreting it.
    "Format each line as:  1. <label> | <prompt>\n"
    "The label is at most 5 words (it goes on a button). The prompt is at most 16 words. "
    "Each must name something real from the facts — a folder, script, branch, or recent "
    "topic. Never invent a file path. Always exactly 4, nothing else.\n\n"
    "Example\n"
    "Project: shopfront\n"
    "Top-level folders: api, web, db\n"
    "Package scripts: dev, test, migrate\n"
    "Current git branch: feat/checkout-retry\n"
    "Recent commits:\n- add retry to payment intent\n- fix cart total rounding\n"
    "The developer's recent chats in this project:\n- Payment retry backoff\n\n"
    "Starters:\n"
    "1. Tour the api | Walk me through how the api folder is structured\n"
    "2. Finish checkout retry | What's left to finish on feat/checkout-retry\n"
    "3. Cart rounding bug | Investigate the cart total rounding fix from the last commit\n"
    "4. Run the tests | Run the test script and fix whatever fails\n"
)

# S3 plus an explicit no-file-paths clause. S1 invented `src/src-tauri/src/main.rs`
# on all four starters in one run, so the question is whether banning paths
# outright costs grounding — folder and script names alone may be enough.
S4_FEWSHOT_NOPATHS = S3_FEWSHOT_FIELDS.replace(
    "Never invent a file path.",
    "NEVER write a file path (no slashes, no .ts/.rs/.json filenames). Refer to "
    "folders and scripts ONLY by the exact names given in the facts.",
)

PROMPTS = {
    "S1-direct": (S1_DIRECT, False),
    "S2-playbook": (S2_PLAYBOOK, False),
    "S3-fewshot-fields": (S3_FEWSHOT_FIELDS, True),
    "S4-fewshot-nopaths": (S4_FEWSHOT_NOPATHS, True),
}


# ── Invocation identical to Rust run_completion ──────────────────────────────
def run(system: str, context: str) -> str:
    prompt = (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{context}<|im_end|>\n"
        f"<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )
    # `-f FILE` instead of `-p PROMPT`.
    #
    # Windows CreateProcess caps the whole command line at 32,767 chars, so a
    # ~12k-token prompt passed via -p dies with WinError 206 ("filename or
    # extension is too long") — measured at 48,807 chars. That ceiling is ~8k
    # tokens regardless of the model's 262k window, and it applies to the Rust
    # pipeline too, which shells out the same way. The existing tasks only
    # escape it because their inputs are capped (TITLE_INPUT_CHARS 1500,
    # SUGGEST_INPUT_CHARS 6000).
    tmp = Path(os.environ.get("TEMP", ".")) / f"agw_starter_prompt_{os.getpid()}.txt"
    tmp.write_text(prompt, encoding="utf-8")
    args = [
        EXE, "-m", MODEL, "-no-cnv", "-f", str(tmp),
        "--no-display-prompt", "--color", "off",
        # Native window is ~262k; 32k comfortably fits the ~10k-token rich
        # context with room for the reply.
        "-n", "220", "-c", "32768", "-ngl", "99", "--no-warmup",
        "--temp", "0.7", "--top-p", "0.8", "--top-k", "20",
    ]
    try:
        r = subprocess.run(args, capture_output=True, text=True,
                           encoding="utf-8", timeout=600)
        return (r.stdout or "").replace("[end of text]", "").strip()
    finally:
        tmp.unlink(missing_ok=True)


# ── Filters (mirror of the Rust sanitizers) ──────────────────────────────────
BLOCKLIST = ("here's ", "here is ", "sure,", "certainly", "as an ai", "starters:")

def strip_marker(line: str) -> str:
    s = line.strip()
    # `N.` is defensive: a format spec written with a placeholder digit gets
    # copied literally by small models. The prompt was fixed, but the parser
    # should not depend on that.
    s = re.sub(r"^(\d{1,2}[.)]\s*|N[.)]\s*|[-*]\s*)", "", s)
    return s.strip().strip('"').strip()


def parse_line(line: str, fielded: bool) -> tuple[str, str] | None:
    s = strip_marker(line)
    if not s or s.lower().startswith(BLOCKLIST):
        return None
    if fielded:
        if "|" not in s:
            return None
        label, prompt = s.split("|", 1)
        label, prompt = label.strip(), prompt.strip().rstrip(".")
        if not label or not prompt:
            return None
        return label, prompt
    return "", s.rstrip(".")


def caps_ok(label: str, prompt: str) -> bool:
    if label and len(label.split()) > LABEL_MAX_WORDS:
        return False
    return 3 <= len(prompt.split()) <= PROMPT_MAX_WORDS


def overlap(a: str, b: str) -> bool:
    sa, sb = set(a.lower().split()), set(b.lower().split())
    return bool(sa) and bool(sb) and len(sa & sb) * 10 >= min(len(sa), len(sb)) * 6


STOPWORDS = set(
    "the a an of to in on for and or is are do does can you i my me we what which how it "
    "this that with about your from into at be by as run show walk tell give explain".split()
)

def vocab(facts: dict) -> set[str]:
    blob = " ".join([
        " ".join(facts["dirs"]), " ".join(facts["scripts"]), facts["branch"],
        " ".join(facts["commits"]), " ".join(facts["titles"]), facts["readme"], facts["name"],
        " ".join(facts.get("tree", [])), " ".join(facts.get("dirty", [])),
    ])
    return set(re.findall(r"[a-z0-9]+", blob.lower()))


def grounded(prompt: str, vocabulary: set[str]) -> bool:
    words = {w for w in re.findall(r"[a-z0-9]+", prompt.lower()) if w not in STOPWORDS}
    return len(words & vocabulary) >= 2


# Tokens that exist ONLY in the few-shot examples. If one of these shows up in
# a starter and is not in the real project vocabulary, the model copied the
# example instead of reading the facts (observed: "Finish checkout retry" and
# "how the api folder is structured" on a project with neither).
EXAMPLE_ONLY = set(
    "shopfront checkout retry cart rounding coupon payment intent migrate login signup "
    "validator guard diff suite email backoff".split()
)

def leaked(prompt: str, vocabulary: set[str]) -> list[str]:
    words = {w for w in re.findall(r"[a-z0-9]+", prompt.lower())}
    return sorted((words & EXAMPLE_ONLY) - vocabulary)


def echoed(prompt: str, titles: list[str]) -> str | None:
    """True when the starter is essentially a past chat title verbatim.

    Re-offering a conversation the developer already had is worse than a
    generic prompt — and the grounding metric REWARDS it (maximum word
    overlap), so it must be scored separately or it hides in the numbers.
    """
    pw = {w for w in re.findall(r"[a-z0-9]+", prompt.lower()) if w not in STOPWORDS}
    if not pw:
        return None
    for t in titles:
        tw = {w for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOPWORDS}
        if not tw:
            continue
        if len(pw & tw) * 10 >= min(len(pw), len(tw)) * 7:
            return t
    return None


PATH_RE = re.compile(r"\b[\w.-]+(?:/[\w.-]+)+\b|\b[\w-]+\.(?:ts|tsx|rs|json|md|css|py|toml)\b")

def bad_paths(prompt: str) -> list[str]:
    """Any path-looking token that does NOT exist in the repo."""
    bad = []
    for tok in PATH_RE.findall(prompt):
        t = tok.strip(".,;:")
        if (ROOT / t).exists():
            continue
        # tolerate a bare filename that exists anywhere shallow in the tree
        if any((ROOT / d / t).exists() for d in ("", "src", "src-tauri", "DOCS", "scripts")):
            continue
        bad.append(t)
    return bad


def evaluate(name: str, system: str, fielded: bool, context: str,
             vocabulary: set[str], titles: list[str]) -> tuple:
    print(f"\n{'=' * 74}\n{name}   (structured={fielded})\n{'=' * 74}")
    agg = []
    for i in range(RUNS_PER_PROMPT):
        raw_out = run(system, context)
        rows, seen_bad = [], []
        for line in raw_out.splitlines():
            parsed = parse_line(line, fielded)
            if not parsed:
                continue
            label, prompt = parsed
            if not caps_ok(label, prompt):
                continue
            if any(overlap(p, prompt) for _, p in rows):
                continue
            rows.append((label, prompt))
            if len(rows) == 4:
                break
        g = sum(1 for _, p in rows if grounded(p, vocabulary))
        ec = sum(1 for _, p in rows if echoed(p, titles))
        lk = sum(1 for _, p in rows if leaked(p, vocabulary))
        for _, p in rows:
            seen_bad += bad_paths(p)
        agg.append((len(rows), g, len(seen_bad), ec, lk))
        print(f"\n--- run {i + 1}: {len(rows)}/4 parsed, {g} grounded, "
              f"{len(seen_bad)} bad paths, {ec} echoed, {lk} leaked ---")
        if not rows:
            print("RAW:", " / ".join(raw_out.splitlines())[:400] or "(empty)")
        for label, p in rows:
            mark = "+" if grounded(p, vocabulary) else "-"
            flags = []
            bp = bad_paths(p)
            if bp:
                flags.append(f"invented: {', '.join(bp)}")
            e = echoed(p, titles)
            if e:
                flags.append(f'ECHOES chat "{e[:38]}"')
            lp = leaked(p, vocabulary)
            if lp:
                flags.append(f"LEAKS example: {', '.join(lp)}")
            tail = ("  !! " + " · ".join(flags)) if flags else ""
            print(f"  [{mark}] {label + ' | ' if label else ''}{p}{tail}")
    n = len(agg)
    avg = tuple(sum(a[i] for a in agg) / n for i in range(5))
    print(f"\nSCORE {name}: parsed {avg[0]:.1f}/4 | grounded {avg[1]:.1f} | "
          f"bad paths {avg[2]:.1f} | echoed {avg[3]:.1f} | leaked {avg[4]:.1f}")
    return (name, *avg)


def main() -> None:
    modes = {"lean": build_context(), "rich": build_rich_context()}
    for label, (ctx, f) in modes.items():
        print(f"[{label:>4} context] {len(ctx):>7,} chars  ~{len(ctx)//4:>6,} tokens  | "
              f"{len(f['titles']):>2} chats | {len(f['commits']):>2} commits | "
              f"{len(f.get('tree', [])):>3} tree lines | vocab {len(vocab(f))}")

    # Only the two candidates worth the wall-clock: S1 (best lean numbers but
    # invents paths) and S3 (best warm behaviour). Isolates ONE variable.
    subset = {k: v for k, v in PROMPTS.items() if k in ("S1-direct", "S3-fewshot-fields")}

    results = []
    for label, (ctx, f) in modes.items():
        v, titles = vocab(f), f["titles"]
        for n, (s, fielded) in subset.items():
            results.append(evaluate(f"{n} [{label}]", s, fielded, ctx, v, titles))

    print(f"\n{'=' * 74}")
    print("SUMMARY   parsed/grounded higher = better · bad/echoed/leaked MUST be 0")
    print("  echoed = re-offers a chat the developer already had")
    print("  leaked = copied the few-shot example instead of the project facts")
    print("=" * 74)
    print(f"{'prompt':<30}{'parsed':>9}{'grounded':>10}{'bad':>6}{'echoed':>8}{'leaked':>8}")
    for name, parsed, ground, bad, ec, lk in results:
        print(f"{name:<30}{parsed:>8.1f}/4{ground:>10.1f}{bad:>6.1f}{ec:>8.1f}{lk:>8.1f}")


if __name__ == "__main__":
    sys.exit(main())
