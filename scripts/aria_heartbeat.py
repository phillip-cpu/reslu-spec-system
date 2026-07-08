#!/usr/bin/env python3
"""
RESLU Second Brain, Step 12 (docs/RESLU-second-brain-build-brief.md)
— the aria_queue heartbeat script (Mac mini).

"Heartbeat script (Mac mini): check aria_queue count via cheap REST
HEAD/count -> zero rows = exit, no model. Rows exist = wake Aria with
the batch."

This script is COMPLETE for the check-and-exit half — the count check
below costs zero tokens and involves no model call whatsoever, which
is the entire point (idle polling must be free). The "wake Aria with
the batch" half is deliberately left as a stub: how an already-running
agent actually gets invoked (an OpenClaw CLI command, an API call, a
file dropped into its workspace vault, something else) depends on
this exact machine's own OpenClaw/Aria setup, which this script has
zero visibility into from where it was written. WAKE_ARIA() below is
the one function that needs finishing on the Mac mini itself, by
whichever session has that visibility (see Step 8's own precedent —
the email-ingest pipeline was built the same way, here for the parts
buildable/testable from a sandbox, finished on the mini for the parts
that aren't).

Only stdlib (urllib) — no new dependency for a single cheap HTTP call,
matching this whole build's "don't add a dependency you don't need"
discipline (lib/second-brain/embeddings.ts and claude.ts made the same
call on the Vercel side).

Env (loaded from ../.env.local, same loader convention as
scripts/email_ingest.py):
  SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import json
import os
import sys
import urllib.request
from pathlib import Path


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def get_pending_queue_count(supabase_url: str, service_role_key: str) -> int:
    """
    Cheap REST count — Supabase/PostgREST returns the total row count
    in the Content-Range response header when sent a Prefer:
    count=exact header, without ever transferring row data. limit=0
    keeps the response body itself empty too.
    """
    url = f"{supabase_url}/rest/v1/aria_queue?select=id&status=eq.pending&limit=0"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Prefer": "count=exact",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        content_range = resp.headers.get("Content-Range", "*/0")
        # Format: "0-0/42" or "*/0" for an empty result.
        total = content_range.split("/")[-1]
        return int(total) if total.isdigit() else 0


def wake_aria(pending_count: int) -> None:
    """
    STUB — finish this on the Mac mini, where OpenClaw/Aria's actual
    invocation mechanism is visible. Whatever this becomes, it should
    NOT itself claim queue rows (that's get_aria_queue, the Step 2 MCP
    tool, Aria's own job once she's awake) — this function's only
    responsibility is triggering her to start, given there is
    confirmed work waiting.
    """
    print(f"[aria-heartbeat] {pending_count} pending item(s) — wake mechanism not yet wired on this machine.")
    sys.exit(1)


def main() -> None:
    load_env_file(Path(__file__).resolve().parent.parent / ".env.local")

    supabase_url = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    service_role_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        print("[aria-heartbeat] Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        sys.exit(2)

    try:
        pending = get_pending_queue_count(supabase_url, service_role_key)
    except Exception as exc:  # noqa: BLE001 — a heartbeat failing to check is not worth crashing loudly over.
        print(f"[aria-heartbeat] Queue count check failed: {exc}", file=sys.stderr)
        sys.exit(2)

    if pending == 0:
        # Zero rows = exit, no model invoked, zero token cost — the
        # entire point of this script.
        sys.exit(0)

    wake_aria(pending)


if __name__ == "__main__":
    main()
