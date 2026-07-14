# Aria Phase 2 deployment and Mac-mini handoff

Phase 2 turns the existing event queue into a reliable proactive loop without widening Aria's authority.

## Production order

1. Apply `supabase/migrations/055_reliability_and_aria_operating_loop.sql`.
2. Deploy the Spec app and MCP changes from the same commit.
3. Trigger `/api/second-brain/reindex?entity_type=email`, then `entity_type=memory`.
4. Confirm `/health` shows a real latest visit-email run after the next hourly invocation. A successful run with zero sends must be green, not “never”.
5. Manually invoke both `/api/aria-queue/routines/daily_review` and `/api/aria-queue/routines/weekly_review` as an admin. Confirm one queue row is created for each and a second same-day invocation returns `queued: false`. This also seeds both Health monitors before their first scheduled run.

No new environment variables or secrets are introduced by this phase.

## Mac mini

After the production deployment is healthy:

```text
cd /Users/vale/reslu-spec-system
git pull --ff-only
PYTHONPYCACHEPREFIX=/tmp/reslu-pycache python3 -m unittest scripts/test_aria_heartbeat.py
cp scripts/ai.reslu.aria-heartbeat.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/ai.reslu.aria-heartbeat
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.reslu.aria-heartbeat.plist
launchctl kickstart -k gui/$(id -u)/ai.reslu.aria-heartbeat
```

The `bootout` command can report “service not found” on a first install; continue to `bootstrap`. The updated plist runs at login and every five minutes. Check:

```text
launchctl print gui/$(id -u)/ai.reslu.aria-heartbeat
tail -n 50 ~/.openclaw/workspace/vault/agent-openclaw/daily/aria-heartbeat.log
tail -n 50 ~/.openclaw/workspace/vault/agent-openclaw/daily/aria-heartbeat-errors.log
```

## Merge into OpenClaw standing instructions

Do not overwrite the existing `AGENTS.md`, `HEARTBEAT.md` or `MEMORY.md`. Merge this operating rule into `~/.openclaw/workspace/AGENTS.md` (and keep the queue check reference in `HEARTBEAT.md`):

> When a trusted `[aria-heartbeat]` system event says queue work exists, immediately call `get_aria_queue`. Before deciding, call `get_context_snapshot` and search the relevant Second Brain project, lead, email and memory records. Complete safe internal analysis, brief items, tasks and drafts autonomously. Never send, publish, approve, delete, make financial changes or create client commitments without human approval. Resolve every claimed row with sources checked, actions taken and approvals still needed. Use `add_brain_note` only for durable, source-attributed learnings, not reminders or guesses.

The event emitted by `aria_heartbeat.py` repeats these rules so the behaviour is robust even before the standing-instruction merge, but the workspace rule makes the operating style explicit in every session.

## End-to-end acceptance test

1. Enqueue a daily review.
2. Confirm the launchd check detects it without Phillip prompting Aria.
3. Confirm Aria claims it, calls context and search, and produces an internal brief/action or a clear “nothing actionable” resolution.
4. Confirm the queue row becomes `done` with a source-aware note.
5. Confirm no external message, approval, publish action, deletion, financial change or client commitment occurred without explicit human approval.
6. Stop Aria after claim, wait more than 15 minutes, and confirm the abandoned row wakes and is claimable again.
