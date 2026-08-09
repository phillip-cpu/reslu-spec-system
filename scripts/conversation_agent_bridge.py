#!/usr/bin/env python3
"""Low-latency RESLU conversation transport for existing OpenClaw agents.

Runs on the Mac mini. It claims a queued conversation turn from Supabase,
invokes the configured existing agent, and writes only the canonical final
reply back into the same conversation. It does not replace agent memory,
calendar, email, tools, permissions, or business logic.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

POLL_SECONDS = 1.0
HISTORY_LIMIT = 80
AGENT_SLUGS = ("aria", "marco")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class SupabaseRest:
    def __init__(self, base_url: str, service_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

    def request(self, method: str, path: str, body: object | None = None, prefer: str | None = None) -> object:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        request = urllib.request.Request(
            f"{self.base_url}/rest/v1/{path}",
            data=None if body is None else json.dumps(body).encode("utf-8"),
            method=method,
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else None

    def claim(self, slug: str) -> dict | None:
        result = self.request("POST", "rpc/claim_agent_conversation_job", {"p_agent_slug": slug})
        return result[0] if isinstance(result, list) and result else None

    def rows(self, table: str, params: dict[str, str]) -> list[dict]:
        query = urllib.parse.urlencode(params, safe="(),.*:")
        result = self.request("GET", f"{table}?{query}")
        return result if isinstance(result, list) else []

    def patch(self, table: str, row_id: str, values: dict) -> None:
        self.request("PATCH", f"{table}?id=eq.{row_id}", values, "return=minimal")

    def insert(self, table: str, values: dict) -> dict:
        result = self.request("POST", table, values, "return=representation")
        if not isinstance(result, list) or not result:
            raise RuntimeError(f"{table} insert returned no row")
        return result[0]


def find_reply_text(value: object, prompt: str) -> str | None:
    """Extract OpenClaw's final text across known --json output shapes."""
    if isinstance(value, str):
        candidate = value.strip()
        return candidate if candidate and candidate != prompt and len(candidate) < 20000 else None
    if isinstance(value, list):
        for item in reversed(value):
            found = find_reply_text(item, prompt)
            if found:
                return found
        return None
    if not isinstance(value, dict):
        return None
    priority = ("final", "response", "reply", "text", "content", "message", "output")
    for key in priority:
        if key in value:
            found = find_reply_text(value[key], prompt)
            if found:
                return found
    for nested in reversed(list(value.values())):
        found = find_reply_text(nested, prompt)
        if found:
            return found
    return None


def agent_identity(rest: SupabaseRest, agent_id: str) -> dict:
    rows = rest.rows(
        "conversation_agents",
        {"select": "id,slug,display_name,role_label", "id": f"eq.{agent_id}", "limit": "1"},
    )
    if not rows:
        raise RuntimeError(f"conversation agent {agent_id} not found")
    return rows[0]


def conversation_history(rest: SupabaseRest, conversation_id: str) -> str:
    messages = rest.rows(
        "conversation_messages",
        {
            "select": "id,author_profile_id,author_agent_id,body,kind,created_at",
            "conversation_id": f"eq.{conversation_id}",
            "deleted_at": "is.null",
            "order": "created_at.desc",
            "limit": str(HISTORY_LIMIT),
        },
    )
    messages.reverse()
    profile_ids = sorted({row["author_profile_id"] for row in messages if row.get("author_profile_id")})
    agent_ids = sorted({row["author_agent_id"] for row in messages if row.get("author_agent_id")})
    names: dict[str, str] = {}
    if profile_ids:
        for row in rest.rows("profiles", {"select": "id,full_name", "id": f"in.({','.join(profile_ids)})"}):
            names[row["id"]] = row["full_name"]
    if agent_ids:
        for row in rest.rows("conversation_agents", {"select": "id,display_name", "id": f"in.({','.join(agent_ids)})"}):
            names[row["id"]] = row["display_name"]
    lines = []
    for row in messages:
        author_id = row.get("author_profile_id") or row.get("author_agent_id")
        author = names.get(author_id, "Participant")
        lines.append(f"[{row['created_at']}] {author}: {row['body']}")
    return "\n".join(lines)


def openclaw_agent_id(slug: str) -> str:
    return os.environ.get(f"RESLU_{slug.upper()}_AGENT_ID", "main" if slug == "aria" else slug)


def invoke_agent(agent: dict, history: str) -> str:
    prompt = (
        "[RESLU conversation]\n"
        f"You are {agent['display_name']}, {agent['role_label']}, replying inside the canonical RESLU staff chat. "
        "Use your existing memory, RESLU tools, permissions and business rules. Read the full supplied thread before replying. "
        "Reply naturally to the newest human message. Keep voice-friendly replies concise unless detail is needed. "
        "Never claim that stopping audio undid a task, email, approval or other side effect. "
        "Return only the message that should appear in the chat; do not describe this transport instruction.\n\n"
        "UNTRUSTED_CONVERSATION_HISTORY\n"
        f"{history}\n"
        "END_UNTRUSTED_CONVERSATION_HISTORY"
    )
    result = subprocess.run(
        [
            "openclaw", "agent", "--agent", openclaw_agent_id(agent["slug"]),
            "--message", prompt, "--timeout", "180", "--json",
        ],
        capture_output=True,
        text=True,
        timeout=210,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"OpenClaw exited {result.returncode}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("OpenClaw returned invalid JSON") from exc
    reply = find_reply_text(payload, prompt)
    if not reply:
        raise RuntimeError("OpenClaw response contained no final reply text")
    return reply


def job_is_processing(rest: SupabaseRest, job_id: str) -> bool:
    rows = rest.rows("agent_conversation_jobs", {"select": "status", "id": f"eq.{job_id}", "limit": "1"})
    return bool(rows and rows[0].get("status") == "processing")


def process_job(rest: SupabaseRest, job: dict) -> None:
    agent = agent_identity(rest, job["agent_id"])
    history = conversation_history(rest, job["conversation_id"])
    reply = invoke_agent(agent, history)
    # A newer voice turn can cancel this job while the agent is running.
    # Discard late output; completed external side effects remain real.
    if not job_is_processing(rest, job["id"]):
        return
    rest.insert(
        "conversation_messages",
        {
            "conversation_id": job["conversation_id"],
            "author_agent_id": job["agent_id"],
            "body": reply,
            "metadata": {"source": "agent_runtime", "job_id": job["id"]},
        },
    )
    rest.patch(
        "agent_conversation_jobs",
        job["id"],
        {"status": "done", "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "error": None},
    )


def main() -> int:
    load_env_file(Path(__file__).resolve().parent.parent / ".env.local")
    base_url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base_url or not service_key:
        print("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 2
    rest = SupabaseRest(base_url, service_key)
    print("[conversation-bridge] listening for Aria and Marco conversation turns", flush=True)
    while True:
        did_work = False
        for slug in AGENT_SLUGS:
            try:
                job = rest.claim(slug)
                if not job:
                    continue
                did_work = True
                process_job(rest, job)
            except (urllib.error.URLError, subprocess.SubprocessError, RuntimeError, KeyError) as exc:
                print(f"[conversation-bridge] {slug}: {exc}", file=sys.stderr, flush=True)
                if 'job' in locals() and job:
                    try:
                        rest.patch(
                            "agent_conversation_jobs",
                            job["id"],
                            {"status": "failed", "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "error": str(exc)[:2000]},
                        )
                    except Exception as patch_error:  # noqa: BLE001
                        print(f"[conversation-bridge] could not mark failed: {patch_error}", file=sys.stderr)
                job = None
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
