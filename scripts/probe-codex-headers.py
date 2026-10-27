"""One Codex request: print every response header and the first stream events.

Reads the sign-in Codex CLI keeps (~/.codex/auth.json), posts the smallest
Responses-dialect body the ChatGPT backend accepts, and dumps what comes back
so we can see whether a reply carries the plan's rate limits (headers or an
event) the way a Claude Code reply does.
"""
import json
import os
import sys
import urllib.request
import uuid

auth_path = os.path.join(os.path.expanduser("~"), ".codex", "auth.json")
with open(auth_path, encoding="utf-8") as f:
    auth = json.load(f)
tokens = auth.get("tokens") or {}
access = tokens.get("access_token")
account = tokens.get("account_id")
if not access:
    sys.exit("no access_token in " + auth_path)

body = {
    "model": sys.argv[1] if len(sys.argv) > 1 else "gpt-5.5",
    "instructions": "You are a terse assistant.",
    "input": [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Say hi."}]}
    ],
    "stream": True,
    "store": False,
    "include": ["reasoning.encrypted_content"],
}
headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": "aurora-ide/probe",
    "originator": "aurora",
    "OpenAI-Beta": "responses=experimental",
    "Authorization": "Bearer " + access,
    "session_id": str(uuid.uuid4()),
}
if account:
    headers["ChatGPT-Account-Id"] = account

req = urllib.request.Request(
    "https://chatgpt.com/backend-api/codex/responses",
    data=json.dumps(body).encode(),
    headers=headers,
    method="POST",
)
try:
    resp = urllib.request.urlopen(req, timeout=60)
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    for k, v in e.headers.items():
        print(f"  {k}: {v}")
    print(e.read(2000).decode(errors="replace"))
    sys.exit(1)

print("HTTP", resp.status)
for k, v in resp.headers.items():
    print(f"  {k}: {v}")
print("--- stream (first 4000 bytes) ---")
data = resp.read(4000).decode(errors="replace")
print(data)
