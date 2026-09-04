"""
Aurora Dual-Protocol LLM Streaming Simulator
============================================

Purpose
-------
Stress-test Aurora IDE's streaming UI, scrolling, rendering and request builder.

Endpoints
---------
GET  /v1/models
POST /v1/chat/completions      OpenAI-compatible Chat Completions
POST /v1/responses             OpenAI Responses-style streaming
POST /v1/messages              Anthropic Messages-style streaming
GET  /health

Defaults
--------
Reasoning/thinking: 10,000 simulated tokens
Final answer:        2,000 simulated tokens
Speed:                 500 simulated tokens/sec
Chunk size:              8 words per SSE event

Install
-------
pip install fastapi uvicorn wordfreq

Run
---
python aurora_llm_simulator.py

Environment variables
---------------------
AURORA_SIM_HOST=127.0.0.1
AURORA_SIM_PORT=8000
AURORA_SIM_TPS=500
AURORA_SIM_REASONING_TOKENS=10000
AURORA_SIM_OUTPUT_TOKENS=2000
AURORA_SIM_CHUNK_TOKENS=8
AURORA_SIM_WORD_POOL=20000
AURORA_SIM_LOG_DIR=aurora_sim_logs

Per-request override
--------------------
Add this optional field to any request:

"simulator": {
  "reasoning_tokens": 15000,
  "output_tokens": 3000,
  "tokens_per_second": 900,
  "chunk_tokens": 10
}

Notes
-----
- "tokens" here are simulator units based on emitted English words.
- This is intentionally NOT tokenizer-exact.
- Word generation happens in memory and is far faster than the configured
  streaming rate; pacing is controlled only by asyncio.sleep().
- OpenAI raw private chain-of-thought is not exposed by the official API.
  /v1/responses therefore uses reasoning-summary-style events.
- /v1/chat/completions exposes "reasoning_content" as an OpenAI-compatible
  extension because many gateways/agentic IDEs understand that convention.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterable, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

try:
    from wordfreq import top_n_list
except ImportError as exc:
    raise SystemExit(
        "\nMissing dependency: wordfreq\n"
        "Install it with:\n"
        "    pip install fastapi uvicorn wordfreq\n"
    ) from exc


APP_NAME = "Aurora LLM Streaming Simulator"

HOST = os.getenv("AURORA_SIM_HOST", "127.0.0.1")
PORT = int(os.getenv("AURORA_SIM_PORT", "8000"))

DEFAULT_TPS = float(os.getenv("AURORA_SIM_TPS", "500"))
DEFAULT_REASONING_TOKENS = int(os.getenv("AURORA_SIM_REASONING_TOKENS", "10000"))
DEFAULT_OUTPUT_TOKENS = int(os.getenv("AURORA_SIM_OUTPUT_TOKENS", "2000"))
DEFAULT_CHUNK_TOKENS = max(1, int(os.getenv("AURORA_SIM_CHUNK_TOKENS", "8")))

WORD_POOL_SIZE = max(2000, int(os.getenv("AURORA_SIM_WORD_POOL", "20000")))
LOG_DIR = Path(os.getenv("AURORA_SIM_LOG_DIR", "aurora_sim_logs"))

app = FastAPI(title=APP_NAME, version="2.0.0")
LOG_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# English word pool
# ---------------------------------------------------------------------------

def build_word_pool() -> list[str]:
    """
    Load a large pool of real English words once at startup.

    Skip the very highest-frequency words so the stream looks more varied.
    Filter aggressively enough to avoid punctuation-heavy or odd entries.
    """
    raw = top_n_list("en", WORD_POOL_SIZE + 1000, ascii_only=True)

    words: list[str] = []
    seen: set[str] = set()

    for word in raw[250:]:
        w = word.strip().lower()

        if not w:
            continue
        if w in seen:
            continue
        if not w.isalpha():
            continue
        if len(w) < 3 or len(w) > 15:
            continue

        seen.add(w)
        words.append(w)

        if len(words) >= WORD_POOL_SIZE:
            break

    if len(words) < 1000:
        raise RuntimeError("Could not build a sufficiently large English word pool.")

    return words


ENGLISH_WORDS = build_word_pool()

# Separate mini-pools produce slightly different visual character between
# reasoning and answer streams.
REASONING_WORDS = ENGLISH_WORDS[: max(1000, int(len(ENGLISH_WORDS) * 0.85))]
ANSWER_WORDS = ENGLISH_WORDS[max(0, int(len(ENGLISH_WORDS) * 0.05)) :]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def unix_time() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def safe_headers(request: Request) -> Dict[str, str]:
    """
    Log request headers while redacting obvious credentials.
    """
    out: Dict[str, str] = {}

    for key, value in request.headers.items():
        if key.lower() in {
            "authorization",
            "x-api-key",
            "api-key",
            "proxy-authorization",
        }:
            out[key] = "[REDACTED]"
        else:
            out[key] = value

    return out


def prompt_snapshot(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Pull prompt-bearing fields into an easy-to-read summary.

    The COMPLETE original request body is also saved separately.
    """
    return {
        "model": body.get("model"),
        "system": body.get("system"),
        "messages": body.get("messages"),
        "input": body.get("input"),
        "instructions": body.get("instructions"),
        "tools": body.get("tools"),
        "tool_choice": body.get("tool_choice"),
        "thinking": body.get("thinking"),
        "reasoning": body.get("reasoning"),
        "stream": body.get("stream"),
        "max_tokens": body.get("max_tokens"),
        "max_completion_tokens": body.get("max_completion_tokens"),
        "max_output_tokens": body.get("max_output_tokens"),
        "simulator": body.get("simulator"),
    }


# ---------------------------------------------------------------------------
# The model's-eye view
# ---------------------------------------------------------------------------
#
# ONE file, appended to on every request, holding exactly what the model was
# handed — in the order it reads it, with nothing summarised away. The per
# exchange folders beside it are for machines; this is for a person answering
# "what did it actually see?".
#
# It exists because the answer was not obvious from the code. A defect found on
# 2026-09-04 — every tool-loop request ending in a message that looked like the
# user speaking — was invisible to every test and visible immediately in a
# rendered request. So: render the request.

TRANSCRIPT_PATH = LOG_DIR / "conversation.md"

# The literal Aurora splits its system prompt on. Everything before it is the
# cached half; everything after changes mid-conversation. Shown as a divider so
# the split is legible rather than a mystery string in the middle of the text.
SYSTEM_BOUNDARY = "__AURORA_SYSTEM_DYNAMIC_BOUNDARY__"

_request_counter = 0


def _fence(text: str, lang: str = "") -> str:
    """Fence a block, stepping up the backticks if the body has its own."""
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return f"{ticks}{lang}\n{text}\n{ticks}"


def _cache_note(obj: Any) -> str:
    """Say where a cache breakpoint sits — the thing that is impossible to see
    from a transcript and expensive to get wrong."""
    if isinstance(obj, dict) and obj.get("cache_control"):
        return "  ← **cache breakpoint**"
    return ""


def _render_system(body: Dict[str, Any]) -> list[str]:
    out: list[str] = []
    system = body.get("system")
    instructions = body.get("instructions")

    if isinstance(system, str) and system:
        blocks: list[tuple[str, str]] = []
        if SYSTEM_BOUNDARY in system:
            static, dynamic = system.split(SYSTEM_BOUNDARY, 1)
            blocks = [("static (cacheable)", static), ("dynamic", dynamic)]
        else:
            blocks = [("system", system)]
        for label, text in blocks:
            out.append(f"### system — {label} · {len(text):,} chars\n")
            out.append(_fence(text.strip()) + "\n")
    elif isinstance(system, list):
        for index, block in enumerate(system):
            text = block.get("text", "") if isinstance(block, dict) else str(block)
            out.append(
                f"### system block {index} · {len(text):,} chars{_cache_note(block)}\n"
            )
            out.append(_fence(text.strip()) + "\n")
    elif isinstance(instructions, str) and instructions:
        out.append(f"### instructions · {len(instructions):,} chars\n")
        out.append(_fence(instructions.strip()) + "\n")
    return out


def _render_tools(body: Dict[str, Any]) -> list[str]:
    tools = body.get("tools")
    if not isinstance(tools, list) or not tools:
        return []
    names: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name") or (tool.get("function") or {}).get("name") or "?"
        names.append(f"{name}{_cache_note(tool)}")
    body_text = "\n".join(f"- {n}" for n in names)
    return [f"### tools · {len(names)}\n", body_text + "\n"]


def _render_content(content: Any) -> list[str]:
    """One message's content, whatever shape the protocol uses for it."""
    if content is None:
        return ["_(empty)_\n"]
    if isinstance(content, str):
        return [_fence(content) + "\n"]

    out: list[str] = []
    for block in content if isinstance(content, list) else [content]:
        if not isinstance(block, dict):
            out.append(_fence(str(block)) + "\n")
            continue
        kind = block.get("type", "?")
        if kind == "text":
            out.append(f"**text**{_cache_note(block)}\n")
            out.append(_fence(block.get("text", "")) + "\n")
        elif kind == "thinking":
            out.append("**thinking**\n")
            out.append(_fence(block.get("thinking", "")) + "\n")
        elif kind in ("tool_use", "function_call"):
            args = block.get("input", block.get("arguments"))
            out.append(f"**calls `{block.get('name', '?')}`**\n")
            out.append(_fence(json_dumps(args)) + "\n")
        elif kind == "tool_result":
            # In FULL. This is the one place the frozen runtime-state block
            # shows up, and truncating it would hide the thing worth seeing.
            out.append(f"**tool result** for `{block.get('tool_use_id', '?')}`\n")
            inner = block.get("content")
            if isinstance(inner, str):
                out.append(_fence(inner) + "\n")
            else:
                out.extend(_render_content(inner))
        elif kind == "image":
            out.append("**image** _(bytes not shown)_\n")
        else:
            out.append(f"**{kind}**\n")
            out.append(_fence(json_dumps(block)) + "\n")
    return out


def _render_messages(body: Dict[str, Any]) -> list[str]:
    messages = body.get("messages")
    if not isinstance(messages, list):
        messages = body.get("input")
    if not isinstance(messages, list):
        return []

    out: list[str] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        role = message.get("role", message.get("type", "?"))
        header = f"### [{index}] {role}"
        # An OpenAI-shaped tool answer is its own role; say which call it
        # answers so the pairing is checkable by eye.
        if message.get("tool_call_id"):
            header += f" · answers `{message['tool_call_id']}`"
        out.append(header + "\n")

        if message.get("tool_calls"):
            for call in message["tool_calls"]:
                fn = call.get("function", {}) if isinstance(call, dict) else {}
                out.append(f"**calls `{fn.get('name', '?')}`**\n")
                out.append(_fence(str(fn.get("arguments", ""))) + "\n")

        out.extend(_render_content(message.get("content")))
    return out


def append_transcript(protocol: str, endpoint: str, body: Dict[str, Any]) -> None:
    """Append one rendered request to the single conversation file."""
    global _request_counter
    _request_counter += 1

    parts: list[str] = [
        f"\n\n---\n\n# Request {_request_counter} · {protocol} · {endpoint}\n",
        f"_{now_iso()} · model `{body.get('model', '?')}`_\n",
    ]
    parts.extend(_render_system(body))
    parts.extend(_render_tools(body))
    parts.append(f"## Messages the model reads, in order\n")
    parts.extend(_render_messages(body))

    with TRANSCRIPT_PATH.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(parts))


# ---------------------------------------------------------------------------
# Scripted tool calls
# ---------------------------------------------------------------------------
#
# Without these the simulator only ever answers, so the request never grows
# past "system + one user message" and the interesting shapes — the tool
# result, what rides inside it, where the cache breakpoint lands on the second
# iteration — are never produced at all.
#
# The script runs per USER message: reason, speak, call a tool; get the result;
# again; again; then answer. Send another message and it starts over. Three
# rounds is enough to see history accumulate and short enough to read.
#
# `todo` appears twice on purpose. It is the one call that changes the
# checklist, so the frozen state snapshots in successive tool results differ —
# which is exactly what you want to look at when checking that older history
# stays put and only the newest state is current.
#
# Every tool here is read-only or Aurora's own bookkeeping. The simulator drives
# a real agent against a real workspace; it must not be able to damage one.

TOOL_SCRIPT: list[tuple[str, Dict[str, Any]]] = [
    (
        "todo",
        {
            "op": "set",
            "todos": [
                {"id": "t1", "content": "Look at the project layout",
                 "activeForm": "Looking at the project layout", "status": "in_progress"},
                {"id": "t2", "content": "Read the README",
                 "activeForm": "Reading the README", "status": "pending"},
                {"id": "t3", "content": "Report back",
                 "activeForm": "Reporting back", "status": "pending"},
            ],
        },
    ),
    ("file_read", {"path": ["README.md"]}),
    ("todo", {"op": "update", "id": "t1", "status": "completed"}),
]

TOOL_SCRIPT_ENABLED = os.getenv("AURORA_SIM_TOOL_SCRIPT", "1") not in ("0", "false", "no")

# Scripted turns keep their prose short: the point of them is the SHAPE of the
# request, and ten thousand words of filler between each tool call turns a
# readable transcript into a scroll.
SCRIPT_REASONING_TOKENS = int(os.getenv("AURORA_SIM_SCRIPT_REASONING_TOKENS", "60"))
SCRIPT_OUTPUT_TOKENS = int(os.getenv("AURORA_SIM_SCRIPT_OUTPUT_TOKENS", "30"))


def _is_tool_answer(message: Any) -> bool:
    """True for a message that answers a tool call, in any of the three shapes."""
    if not isinstance(message, dict):
        return False
    if message.get("role") == "tool" or message.get("type") == "function_call_output":
        return True
    content = message.get("content")
    if isinstance(content, list):
        return any(
            isinstance(block, dict) and block.get("type") == "tool_result"
            for block in content
        )
    return False


def script_step(body: Dict[str, Any]) -> Optional[tuple[str, Dict[str, Any]]]:
    """
    Which tool to call on this request, or `None` to answer instead.

    Counted from the conversation itself rather than kept in server state: the
    step is "how many tool answers have arrived since the user last spoke",
    which is a fact about the request and stays right even when several
    conversations are in flight at once.
    """
    if not TOOL_SCRIPT_ENABLED:
        return None
    messages = body.get("messages")
    if not isinstance(messages, list):
        messages = body.get("input")
    if not isinstance(messages, list):
        return None

    answered = 0
    for message in reversed(messages):
        if _is_tool_answer(message):
            answered += 1
            continue
        # A real user message ends the count. A tool answer wears the `user`
        # role on the Anthropic wire, which is why `_is_tool_answer` is checked
        # first and this is only reached by actual user text.
        if isinstance(message, dict) and message.get("role") == "user":
            break

    return TOOL_SCRIPT[answered] if answered < len(TOOL_SCRIPT) else None


def simulator_config(body: Dict[str, Any]) -> tuple[int, int, float, int]:
    sim = body.get("simulator") or {}

    reasoning_tokens = max(
        0,
        int(sim.get("reasoning_tokens", DEFAULT_REASONING_TOKENS)),
    )
    output_tokens = max(
        0,
        int(sim.get("output_tokens", DEFAULT_OUTPUT_TOKENS)),
    )
    tps = max(
        1.0,
        float(sim.get("tokens_per_second", DEFAULT_TPS)),
    )
    chunk_tokens = max(
        1,
        int(sim.get("chunk_tokens", DEFAULT_CHUNK_TOKENS)),
    )

    return reasoning_tokens, output_tokens, tps, chunk_tokens


def generate_words(count: int, phase: str) -> str:
    """
    Generate visually varied English text very quickly.

    random.choices() operates on an in-memory word list and is much faster
    than the intentionally throttled network stream.
    """
    if count <= 0:
        return ""

    pool = REASONING_WORDS if phase == "reasoning" else ANSWER_WORDS
    words = random.choices(pool, k=count)

    # Introduce occasional punctuation/newlines so the UI visibly changes,
    # without wasting CPU building actual semantic prose.
    out: list[str] = []

    for i, word in enumerate(words, start=1):
        out.append(word)

        r = random.random()

        if i % 70 == 0:
            out.append(".\n")
        elif i % 24 == 0:
            out.append(". ")
        elif r < 0.018:
            out.append(", ")
        else:
            out.append(" ")

    return "".join(out)


def word_chunks(total_tokens: int, chunk_tokens: int, phase: str) -> Iterable[tuple[str, int]]:
    remaining = total_tokens

    while remaining > 0:
        n = min(chunk_tokens, remaining)
        yield generate_words(n, phase), n
        remaining -= n


def build_full_text(total_tokens: int, chunk_tokens: int, phase: str) -> str:
    return "".join(
        text
        for text, _ in word_chunks(
            total_tokens=total_tokens,
            chunk_tokens=chunk_tokens,
            phase=phase,
        )
    )


def sse(data: Dict[str, Any], event: Optional[str] = None) -> str:
    if event:
        return f"event: {event}\ndata: {json_dumps(data)}\n\n"
    return f"data: {json_dumps(data)}\n\n"


class ExchangeLogger:
    def __init__(
        self,
        protocol: str,
        endpoint: str,
        request: Request,
        body: Dict[str, Any],
    ):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        self.exchange_id = f"{protocol}-{stamp}-{uuid.uuid4().hex[:8]}"
        self.dir = LOG_DIR / self.exchange_id
        self.dir.mkdir(parents=True, exist_ok=True)

        self.events_path = self.dir / "stream.jsonl"
        self.started = time.perf_counter()

        request_record = {
            "exchange_id": self.exchange_id,
            "received_at": now_iso(),
            "protocol": protocol,
            "endpoint": endpoint,
            "method": request.method,
            "url": str(request.url),
            "client": {
                "host": request.client.host if request.client else None,
                "port": request.client.port if request.client else None,
            },
            "headers": safe_headers(request),
            "query": dict(request.query_params),
            "prompt_snapshot": prompt_snapshot(body),
            "body": body,
        }

        (self.dir / "request.json").write_text(
            json.dumps(request_record, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # The same request, rendered for a person, appended to the ONE file
        # that holds the whole conversation from the model's side.
        try:
            append_transcript(protocol, endpoint, body)
        except Exception as error:  # never let logging break a stream
            print(f"[sim] transcript failed: {error}")

    def event(
        self,
        wire: str,
        payload: Any,
        event_name: Optional[str] = None,
    ) -> None:
        record = {
            "t_ms": round((time.perf_counter() - self.started) * 1000, 3),
            "event": event_name,
            "payload": payload,
            "wire": wire,
        }

        with self.events_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def complete(self, summary: Dict[str, Any]) -> None:
        final = {
            "exchange_id": self.exchange_id,
            "completed_at": now_iso(),
            "elapsed_seconds": round(time.perf_counter() - self.started, 6),
            **summary,
        }

        (self.dir / "summary.json").write_text(
            json.dumps(final, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


async def paced_yield(
    logger: ExchangeLogger,
    wire: str,
    payload: Any,
    event_name: Optional[str],
    simulated_tokens: int,
    tps: float,
) -> str:
    """
    Log first, then pace according to configured simulated throughput.
    """
    logger.event(wire=wire, payload=payload, event_name=event_name)

    if simulated_tokens > 0:
        await asyncio.sleep(simulated_tokens / tps)

    return wire


# ---------------------------------------------------------------------------
# Root / health / models
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    return {
        "name": APP_NAME,
        "version": "2.0.0",
        "openai_chat": "/v1/chat/completions",
        "openai_responses": "/v1/responses",
        "anthropic_messages": "/v1/messages",
        "models": "/v1/models",
        "health": "/health",
        "logs": str(LOG_DIR.resolve()),
        "word_pool_size": len(ENGLISH_WORDS),
        "defaults": {
            "tokens_per_second": DEFAULT_TPS,
            "reasoning_tokens": DEFAULT_REASONING_TOKENS,
            "output_tokens": DEFAULT_OUTPUT_TOKENS,
            "chunk_tokens": DEFAULT_CHUNK_TOKENS,
        },
    }


@app.get("/health")
async def health():
    return {
        "ok": True,
        "time": now_iso(),
        "word_pool_size": len(ENGLISH_WORDS),
    }


@app.get("/v1/models")
async def models():
    created = unix_time()

    ids = [
        "aurora-sim-openai",
        "aurora-sim-reasoning",
        "aurora-sim-anthropic",
        "gpt-5.6-sol-sim",
        "claude-opus-5-sim",
    ]

    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "created": created,
                "owned_by": "aurora-simulator",
            }
            for model_id in ids
        ],
    }


# ---------------------------------------------------------------------------
# OpenAI Chat Completions
# ---------------------------------------------------------------------------

@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    body = await request.json()
    logger = ExchangeLogger(
        "openai-chat",
        "/v1/chat/completions",
        request,
        body,
    )

    reasoning_tokens, output_tokens, tps, chunk_tokens = simulator_config(body)

    stream = bool(body.get("stream", False))
    model = body.get("model", "aurora-sim-openai")
    completion_id = new_id("chatcmpl")
    created = unix_time()

    # A scripted turn thinks briefly, says one line, and calls a tool. The long
    # prose is for the streaming stress test; here the shape is the point.
    step = script_step(body)
    if step:
        reasoning_tokens = SCRIPT_REASONING_TOKENS
        output_tokens = SCRIPT_OUTPUT_TOKENS

    if not stream:
        reasoning = build_full_text(
            reasoning_tokens,
            chunk_tokens,
            "reasoning",
        )
        content = build_full_text(
            output_tokens,
            chunk_tokens,
            "answer",
        )

        payload = {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                        "reasoning_content": reasoning,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": reasoning_tokens + output_tokens,
                "total_tokens": reasoning_tokens + output_tokens,
                "completion_tokens_details": {
                    "reasoning_tokens": reasoning_tokens,
                },
            },
        }

        logger.event(json_dumps(payload), payload, "response")
        logger.complete(
            {
                "reasoning_tokens": reasoning_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tps,
                "chunk_tokens": chunk_tokens,
                "stream": False,
            }
        )

        return JSONResponse(payload)

    async def gen() -> AsyncIterator[str]:
        # Initial role chunk
        payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant"},
                    "finish_reason": None,
                }
            ],
        }

        wire = sse(payload)
        yield await paced_yield(logger, wire, payload, None, 0, tps)

        # Reasoning phase
        for text, n in word_chunks(
            reasoning_tokens,
            chunk_tokens,
            "reasoning",
        ):
            payload = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "reasoning_content": text,
                        },
                        "finish_reason": None,
                    }
                ],
            }

            wire = sse(payload)
            yield await paced_yield(logger, wire, payload, None, n, tps)

        # Final visible answer phase
        for text, n in word_chunks(
            output_tokens,
            chunk_tokens,
            "answer",
        ):
            payload = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "content": text,
                        },
                        "finish_reason": None,
                    }
                ],
            }

            wire = sse(payload)
            yield await paced_yield(logger, wire, payload, None, n, tps)

        # The tool call, when this turn is a scripted one. Emitted whole in a
        # single delta rather than dribbled across chunks: Aurora's own
        # streaming assembly is exercised by the prose above, and a call split
        # mid-JSON tests the client's buffering, not the request shape this
        # simulator exists to show.
        if step:
            name, arguments = step
            payload = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": new_id("call"),
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": json_dumps(arguments),
                                    },
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            }
            wire = sse(payload)
            yield await paced_yield(logger, wire, payload, None, 0, tps)

        # Finish chunk
        payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "tool_calls" if step else "stop",
                }
            ],
        }

        wire = sse(payload)
        yield await paced_yield(logger, wire, payload, None, 0, tps)

        done_wire = "data: [DONE]\n\n"
        logger.event(done_wire, "[DONE]", None)
        yield done_wire

        logger.complete(
            {
                "reasoning_tokens": reasoning_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tps,
                "chunk_tokens": chunk_tokens,
                "stream": True,
            }
        )

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Aurora-Sim-Exchange": logger.exchange_id,
        },
    )


# ---------------------------------------------------------------------------
# OpenAI Responses API
# ---------------------------------------------------------------------------

@app.post("/v1/responses")
async def openai_responses(request: Request):
    body = await request.json()

    logger = ExchangeLogger(
        "openai-responses",
        "/v1/responses",
        request,
        body,
    )

    reasoning_tokens, output_tokens, tps, chunk_tokens = simulator_config(body)

    stream = bool(body.get("stream", False))
    model = body.get("model", "aurora-sim-reasoning")

    response_id = new_id("resp")
    reasoning_item_id = new_id("rs")
    message_item_id = new_id("msg")
    created = unix_time()

    if not stream:
        reasoning = build_full_text(
            reasoning_tokens,
            chunk_tokens,
            "reasoning",
        )
        content = build_full_text(
            output_tokens,
            chunk_tokens,
            "answer",
        )

        final_response = {
            "id": response_id,
            "object": "response",
            "created_at": created,
            "status": "completed",
            "model": model,
            "output": [
                {
                    "id": reasoning_item_id,
                    "type": "reasoning",
                    "summary": [
                        {
                            "type": "summary_text",
                            "text": reasoning,
                        }
                    ],
                },
                {
                    "id": message_item_id,
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": content,
                            "annotations": [],
                        }
                    ],
                },
            ],
            "usage": {
                "input_tokens": 0,
                "output_tokens": reasoning_tokens + output_tokens,
                "output_tokens_details": {
                    "reasoning_tokens": reasoning_tokens,
                },
                "total_tokens": reasoning_tokens + output_tokens,
            },
        }

        logger.event(json_dumps(final_response), final_response, "response")
        logger.complete(
            {
                "reasoning_tokens": reasoning_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tps,
                "chunk_tokens": chunk_tokens,
                "stream": False,
            }
        )

        return JSONResponse(final_response)

    async def gen() -> AsyncIterator[str]:
        sequence = 0

        async def emit(
            name: str,
            payload: Dict[str, Any],
            n: int = 0,
        ) -> str:
            nonlocal sequence

            payload.setdefault("sequence_number", sequence)
            sequence += 1

            wire = sse(payload, name)

            return await paced_yield(
                logger,
                wire,
                payload,
                name,
                n,
                tps,
            )

        # response.created
        yield await emit(
            "response.created",
            {
                "type": "response.created",
                "response": {
                    "id": response_id,
                    "object": "response",
                    "created_at": created,
                    "status": "in_progress",
                    "model": model,
                    "output": [],
                },
            },
        )

        # Reasoning summary item
        yield await emit(
            "response.output_item.added",
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "id": reasoning_item_id,
                    "type": "reasoning",
                    "summary": [],
                },
            },
        )

        yield await emit(
            "response.reasoning_summary_part.added",
            {
                "type": "response.reasoning_summary_part.added",
                "item_id": reasoning_item_id,
                "output_index": 0,
                "summary_index": 0,
                "part": {
                    "type": "summary_text",
                    "text": "",
                },
            },
        )

        reasoning_parts: list[str] = []

        for text, n in word_chunks(
            reasoning_tokens,
            chunk_tokens,
            "reasoning",
        ):
            reasoning_parts.append(text)

            yield await emit(
                "response.reasoning_summary_text.delta",
                {
                    "type": "response.reasoning_summary_text.delta",
                    "item_id": reasoning_item_id,
                    "output_index": 0,
                    "summary_index": 0,
                    "delta": text,
                },
                n,
            )

        reasoning = "".join(reasoning_parts)

        yield await emit(
            "response.reasoning_summary_text.done",
            {
                "type": "response.reasoning_summary_text.done",
                "item_id": reasoning_item_id,
                "output_index": 0,
                "summary_index": 0,
                "text": reasoning,
            },
        )

        yield await emit(
            "response.reasoning_summary_part.done",
            {
                "type": "response.reasoning_summary_part.done",
                "item_id": reasoning_item_id,
                "output_index": 0,
                "summary_index": 0,
                "part": {
                    "type": "summary_text",
                    "text": reasoning,
                },
            },
        )

        yield await emit(
            "response.output_item.done",
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": reasoning_item_id,
                    "type": "reasoning",
                    "summary": [
                        {
                            "type": "summary_text",
                            "text": reasoning,
                        }
                    ],
                },
            },
        )

        # Visible assistant message
        yield await emit(
            "response.output_item.added",
            {
                "type": "response.output_item.added",
                "output_index": 1,
                "item": {
                    "id": message_item_id,
                    "type": "message",
                    "status": "in_progress",
                    "role": "assistant",
                    "content": [],
                },
            },
        )

        yield await emit(
            "response.content_part.added",
            {
                "type": "response.content_part.added",
                "item_id": message_item_id,
                "output_index": 1,
                "content_index": 0,
                "part": {
                    "type": "output_text",
                    "text": "",
                    "annotations": [],
                },
            },
        )

        answer_parts: list[str] = []

        for text, n in word_chunks(
            output_tokens,
            chunk_tokens,
            "answer",
        ):
            answer_parts.append(text)

            yield await emit(
                "response.output_text.delta",
                {
                    "type": "response.output_text.delta",
                    "item_id": message_item_id,
                    "output_index": 1,
                    "content_index": 0,
                    "delta": text,
                },
                n,
            )

        content = "".join(answer_parts)

        yield await emit(
            "response.output_text.done",
            {
                "type": "response.output_text.done",
                "item_id": message_item_id,
                "output_index": 1,
                "content_index": 0,
                "text": content,
            },
        )

        yield await emit(
            "response.content_part.done",
            {
                "type": "response.content_part.done",
                "item_id": message_item_id,
                "output_index": 1,
                "content_index": 0,
                "part": {
                    "type": "output_text",
                    "text": content,
                    "annotations": [],
                },
            },
        )

        final_message_item = {
            "id": message_item_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [
                {
                    "type": "output_text",
                    "text": content,
                    "annotations": [],
                }
            ],
        }

        yield await emit(
            "response.output_item.done",
            {
                "type": "response.output_item.done",
                "output_index": 1,
                "item": final_message_item,
            },
        )

        final_response = {
            "id": response_id,
            "object": "response",
            "created_at": created,
            "status": "completed",
            "model": model,
            "output": [
                {
                    "id": reasoning_item_id,
                    "type": "reasoning",
                    "summary": [
                        {
                            "type": "summary_text",
                            "text": reasoning,
                        }
                    ],
                },
                final_message_item,
            ],
            "usage": {
                "input_tokens": 0,
                "output_tokens": reasoning_tokens + output_tokens,
                "output_tokens_details": {
                    "reasoning_tokens": reasoning_tokens,
                },
                "total_tokens": reasoning_tokens + output_tokens,
            },
        }

        yield await emit(
            "response.completed",
            {
                "type": "response.completed",
                "response": final_response,
            },
        )

        logger.complete(
            {
                "reasoning_tokens": reasoning_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tps,
                "chunk_tokens": chunk_tokens,
                "stream": True,
            }
        )

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Aurora-Sim-Exchange": logger.exchange_id,
        },
    )


# ---------------------------------------------------------------------------
# Anthropic Messages API
# ---------------------------------------------------------------------------

@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    body = await request.json()

    logger = ExchangeLogger(
        "anthropic",
        "/v1/messages",
        request,
        body,
    )

    reasoning_tokens, output_tokens, tps, chunk_tokens = simulator_config(body)

    stream = bool(body.get("stream", False))
    model = body.get("model", "aurora-sim-anthropic")

    message_id = new_id("msg")
    signature = "aurora-simulator-signature-" + uuid.uuid4().hex

    # See the chat-completions handler: a scripted turn is short, because its
    # value is the shape of the next request rather than the prose.
    step = script_step(body)
    if step:
        reasoning_tokens = SCRIPT_REASONING_TOKENS
        output_tokens = SCRIPT_OUTPUT_TOKENS

    if not stream:
        reasoning = build_full_text(
            reasoning_tokens,
            chunk_tokens,
            "reasoning",
        )
        content = build_full_text(
            output_tokens,
            chunk_tokens,
            "answer",
        )

        payload = {
            "id": message_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [
                {
                    "type": "thinking",
                    "thinking": reasoning,
                    "signature": signature,
                },
                {
                    "type": "text",
                    "text": content,
                },
            ],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": 0,
                "output_tokens": reasoning_tokens + output_tokens,
            },
        }

        logger.event(json_dumps(payload), payload, "response")
        logger.complete(
            {
                "reasoning_tokens": reasoning_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tps,
                "chunk_tokens": chunk_tokens,
                "stream": False,
            }
        )

        return JSONResponse(payload)

    async def gen() -> AsyncIterator[str]:
        # message_start
        payload = {
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 1,
                },
            },
        }

        wire = sse(payload, "message_start")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "message_start",
            0,
            tps,
        )

        # Thinking block starts
        payload = {
            "type": "content_block_start",
            "index": 0,
            "content_block": {
                "type": "thinking",
                "thinking": "",
                "signature": "",
            },
        }

        wire = sse(payload, "content_block_start")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "content_block_start",
            0,
            tps,
        )

        # Thinking deltas
        for text, n in word_chunks(
            reasoning_tokens,
            chunk_tokens,
            "reasoning",
        ):
            payload = {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "thinking_delta",
                    "thinking": text,
                },
            }

            wire = sse(payload, "content_block_delta")
            yield await paced_yield(
                logger,
                wire,
                payload,
                "content_block_delta",
                n,
                tps,
            )

        # Thinking signature
        payload = {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "signature_delta",
                "signature": signature,
            },
        }

        wire = sse(payload, "content_block_delta")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "content_block_delta",
            0,
            tps,
        )

        # Thinking block stop
        payload = {
            "type": "content_block_stop",
            "index": 0,
        }

        wire = sse(payload, "content_block_stop")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "content_block_stop",
            0,
            tps,
        )

        # Text block start
        payload = {
            "type": "content_block_start",
            "index": 1,
            "content_block": {
                "type": "text",
                "text": "",
            },
        }

        wire = sse(payload, "content_block_start")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "content_block_start",
            0,
            tps,
        )

        # Text deltas
        for text, n in word_chunks(
            output_tokens,
            chunk_tokens,
            "answer",
        ):
            payload = {
                "type": "content_block_delta",
                "index": 1,
                "delta": {
                    "type": "text_delta",
                    "text": text,
                },
            }

            wire = sse(payload, "content_block_delta")
            yield await paced_yield(
                logger,
                wire,
                payload,
                "content_block_delta",
                n,
                tps,
            )

        # Text block stop
        payload = {
            "type": "content_block_stop",
            "index": 1,
        }

        wire = sse(payload, "content_block_stop")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "content_block_stop",
            0,
            tps,
        )

        # The tool call, when this turn is a scripted one. Its own content
        # block after the text, which is the shape Anthropic sends: a thinking
        # block, a text block, then `tool_use`.
        if step:
            name, arguments = step
            payload = {
                "type": "content_block_start",
                "index": 2,
                "content_block": {
                    "type": "tool_use",
                    "id": new_id("toolu"),
                    "name": name,
                    "input": {},
                },
            }
            wire = sse(payload, "content_block_start")
            yield await paced_yield(
                logger, wire, payload, "content_block_start", 0, tps
            )

            # The arguments arrive as one `partial_json` delta. Aurora
            # accumulates them either way, and one piece keeps the transcript
            # readable.
            payload = {
                "type": "content_block_delta",
                "index": 2,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json_dumps(arguments),
                },
            }
            wire = sse(payload, "content_block_delta")
            yield await paced_yield(
                logger, wire, payload, "content_block_delta", 0, tps
            )

            payload = {"type": "content_block_stop", "index": 2}
            wire = sse(payload, "content_block_stop")
            yield await paced_yield(
                logger, wire, payload, "content_block_stop", 0, tps
            )

        # message_delta
        payload = {
            "type": "message_delta",
            "delta": {
                "stop_reason": "tool_use" if step else "end_turn",
                "stop_sequence": None,
            },
            "usage": {
                "output_tokens": reasoning_tokens + output_tokens,
            },
        }

        wire = sse(payload, "message_delta")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "message_delta",
            0,
            tps,
        )

        # message_stop
        payload = {
            "type": "message_stop",
        }

        wire = sse(payload, "message_stop")
        yield await paced_yield(
            logger,
            wire,
            payload,
            "message_stop",
            0,
            tps,
        )

        logger.complete(
            {
                "reasoning_tokens": reasoning_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tps,
                "chunk_tokens": chunk_tokens,
                "stream": True,
            }
        )

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Aurora-Sim-Exchange": logger.exchange_id,
        },
    )


# ---------------------------------------------------------------------------
# Debug endpoint
# ---------------------------------------------------------------------------

@app.post("/debug/echo")
async def debug_echo(request: Request):
    try:
        body = await request.json()
    except Exception:
        raw = await request.body()
        body = {
            "raw": raw.decode("utf-8", errors="replace"),
        }

    return {
        "method": request.method,
        "url": str(request.url),
        "headers": safe_headers(request),
        "body": body,
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    estimated_seconds = (
        DEFAULT_REASONING_TOKENS + DEFAULT_OUTPUT_TOKENS
    ) / DEFAULT_TPS

    print(
        f"""
{APP_NAME} v2
----------------------------------------------------------------
OpenAI Chat      : http://{HOST}:{PORT}/v1/chat/completions
OpenAI Responses : http://{HOST}:{PORT}/v1/responses
Anthropic        : http://{HOST}:{PORT}/v1/messages
Models           : http://{HOST}:{PORT}/v1/models
Health           : http://{HOST}:{PORT}/health
Logs             : {LOG_DIR.resolve()}

English word pool: {len(ENGLISH_WORDS):,}

Defaults
  reasoning      : {DEFAULT_REASONING_TOKENS:,} words
  final output   : {DEFAULT_OUTPUT_TOKENS:,} words
  speed          : {DEFAULT_TPS:,.0f} words/sec
  chunk size     : {DEFAULT_CHUNK_TOKENS} words/event
  SSE event rate : ~{DEFAULT_TPS / DEFAULT_CHUNK_TOKENS:,.1f} events/sec
  full response  : ~{estimated_seconds:.1f} sec
----------------------------------------------------------------
"""
    )

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="info",
    )
