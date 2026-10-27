"""kenari with the API key alone: the quota endpoint and the reply headers.

Reads the kenari row's key out of Aurora's database (read-only), calls
`GET /v1/account/quota`, then sends one tiny chat request and prints the
`x-kenari-*` headers it comes back with. Docs: /en/docs/account-quota and
/en/docs/notifications#response-headers.

    python -I scripts/probe-kenari-quota.py [model]
"""
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

db = os.path.join(os.environ["LOCALAPPDATA"], "AuroraIDE", "data", "aurora.db")
conn = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
row = conn.execute(
    "select api_key from llm_providers where id = 'kenari' or provider_type like 'kenari%' limit 1"
).fetchone()
if not row or not row[0]:
    sys.exit("no kenari key in " + db)
key = row[0]
auth = {"Authorization": "Bearer " + key}


def show(resp):
    print("HTTP", resp.status if hasattr(resp, "status") else resp.code)
    for k, v in resp.headers.items():
        if k.lower().startswith("x-kenari") or k.lower() in ("content-type", "x-ratelimit-remaining"):
            print(f"  {k}: {v}")


print("== GET /v1/account/quota")
try:
    resp = urllib.request.urlopen(
        urllib.request.Request("https://kenari.id/v1/account/quota", headers=auth), timeout=30
    )
    show(resp)
    print(json.dumps(json.loads(resp.read().decode()), indent=2))
except urllib.error.HTTPError as e:
    show(e)
    print(e.read(2000).decode(errors="replace"))

print("\n== POST /v1/chat/completions")
model = sys.argv[1] if len(sys.argv) > 1 else "step-3-7-flash:free"
body = {"model": model, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 5}
req = urllib.request.Request(
    "https://kenari.id/v1/chat/completions",
    data=json.dumps(body).encode(),
    headers={**auth, "Content-Type": "application/json"},
    method="POST",
)
try:
    resp = urllib.request.urlopen(req, timeout=60)
    show(resp)
    print(resp.read(600).decode(errors="replace"))
except urllib.error.HTTPError as e:
    show(e)
    print(e.read(1000).decode(errors="replace"))
