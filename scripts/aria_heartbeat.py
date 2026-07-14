#!/usr/bin/env python3
from __future__ import annotations

"""
RESLU Second Brain, Step 12 (docs/RESLU-second-brain-build-brief.md)
— the aria_queue heartbeat script (Mac mini).

"Heartbeat script (Mac mini): check aria_queue count via cheap REST
HEAD/count -> zero rows = exit, no model. Rows exist = wake Aria with
the batch."

The count check costs zero tokens and invokes no model when there is no
work. Pending rows AND abandoned picked_up rows older than the queue's
15-minute visibility timeout are counted, matching the database claim
function exactly. When work exists the script injects a trusted system
event into OpenClaw and wakes Aria immediately. A successful wake starts
a 20-minute local cooldown so the five-minute launchd check cannot keep
injecting duplicate events into a session that is already working. An
empty queue clears the cooldown immediately.

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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode


WAKE_COOLDOWN = timedelta(minutes=20)
DEFAULT_STATE_PATH = Path.home() / ".openclaw" / "aria-heartbeat-state.json"


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


def _queue_count_url(supabase_url: str, **filters: str) -> str:
    query = urlencode({"select": "id", "limit": "0", **filters})
    return f"{supabase_url}/rest/v1/aria_queue?{query}"


def _queue_count(supabase_url: str, service_role_key: str, **filters: str) -> int:
    """
    Cheap REST count — Supabase/PostgREST returns the total row count
    in the Content-Range response header when sent a Prefer:
    count=exact header, without ever transferring row data. limit=0
    keeps the response body itself empty too.
    """
    url = _queue_count_url(supabase_url, **filters)
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


def get_actionable_queue_count(supabase_url: str, service_role_key: str) -> int:
    """Count every row the database claim function can claim right now."""
    abandoned_before = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    pending = _queue_count(
        supabase_url,
        service_role_key,
        status="eq.pending",
    )
    abandoned = _queue_count(
        supabase_url,
        service_role_key,
        status="eq.picked_up",
        picked_up_at=f"lt.{abandoned_before}",
    )
    return pending + abandoned


def heartbeat_state_path() -> Path:
    """Return the local wake-state path, with an override for tests/ops."""
    configured = os.environ.get("ARIA_HEARTBEAT_STATE_PATH")
    return Path(configured).expanduser() if configured else DEFAULT_STATE_PATH


def _last_successful_wake(path: Path) -> datetime | None:
    try:
        payload = json.loads(path.read_text())
        value = payload.get("last_successful_wake_at")
        if not isinstance(value, str):
            return None
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        # Missing/corrupt state must never suppress a real wake.
        return None


def wake_cooldown_remaining(path: Path, now: datetime | None = None) -> timedelta:
    """How long until another successful wake may be injected."""
    last_wake = _last_successful_wake(path)
    if last_wake is None:
        return timedelta(0)
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return max(timedelta(0), WAKE_COOLDOWN - (current - last_wake))


def record_successful_wake(
    path: Path,
    pending_count: int,
    now: datetime | None = None,
) -> None:
    """Atomically persist the last successful OpenClaw wake."""
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(
            {
                "last_successful_wake_at": current.isoformat(),
                "pending_count": pending_count,
            }
        )
    )
    temporary.replace(path)


def clear_wake_state(path: Path) -> None:
    """Reset throttling once the queue is empty so new work wakes promptly."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def wake_aria(pending_count: int) -> bool:
    """
    Inject a system event on the OpenClaw main session and trigger an
    immediate heartbeat wake via `openclaw system event --mode now`.

    This is the local-only invocation path — the Gateway runs on this
    machine (port 18789, no auth token required for loopback calls), so
    a plain subprocess call is enough. The event lands as a System: line
    in the next agent prompt, which tells Aria there is confirmed work
    waiting. She then calls get_aria_queue herself to claim and process
    the rows — this function's only job is the nudge, not the claiming.
    """
    import subprocess

    text = (
        f"[aria-heartbeat] {pending_count} pending aria_queue item(s) detected. "
        "Please claim them with get_aria_queue. Before acting, call get_context_snapshot "
        "and search the relevant Second Brain records. Work autonomously on safe internal "
        "tasks and drafts; keep sends, publishing, approvals, deletions, financial changes "
        "and client commitments behind human approval. Resolve every claimed item with a "
        "source-aware note describing what was checked and done."
    )
    try:
        result = subprocess.run(
            ["openclaw", "system", "event", "--text", text, "--mode", "now", "--json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            print(f"[aria-heartbeat] woke Aria — {pending_count} pending item(s).")
            return True
        else:
            print(
                f"[aria-heartbeat] openclaw system event failed (rc={result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}",
                file=sys.stderr,
            )
            return False
    except FileNotFoundError:
        print(
            "[aria-heartbeat] 'openclaw' not found in PATH — is it installed at /opt/homebrew/bin/openclaw?",
            file=sys.stderr,
        )
        return False
    except subprocess.TimeoutExpired:
        print("[aria-heartbeat] openclaw system event timed out after 30s.", file=sys.stderr)
        return False


def main() -> None:
    load_env_file(Path(__file__).resolve().parent.parent / ".env.local")

    supabase_url = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    service_role_key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        print("[aria-heartbeat] Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        sys.exit(2)

    try:
        pending = get_actionable_queue_count(supabase_url, service_role_key)
    except Exception as exc:  # noqa: BLE001 — a heartbeat failing to check is not worth crashing loudly over.
        print(f"[aria-heartbeat] Queue count check failed: {exc}", file=sys.stderr)
        sys.exit(2)

    state_path = heartbeat_state_path()
    if pending == 0:
        # Zero rows = exit, no model invoked, zero token cost — the
        # entire point of this script. Clearing the successful-wake
        # state lets the next genuinely new item wake Aria immediately.
        clear_wake_state(state_path)
        return

    cooldown = wake_cooldown_remaining(state_path)
    if cooldown > timedelta(0):
        minutes = max(1, int((cooldown.total_seconds() + 59) // 60))
        print(
            f"[aria-heartbeat] {pending} pending item(s); wake already sent — "
            f"retry available in about {minutes} minute(s)."
        )
        return

    if wake_aria(pending):
        record_successful_wake(state_path, pending)
        return

    sys.exit(1)


if __name__ == "__main__":
    main()
