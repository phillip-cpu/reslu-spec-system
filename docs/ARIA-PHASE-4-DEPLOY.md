# Aria Phase 4 deployment and Mac-mini handoff

Phase 4 turns Project Health, booking-delivery evidence and the Future Lead nurture lane into safe internal actions. It does not widen Aria's authority: no automated resend, external contact, project-data correction, stage change, financial change or client commitment is introduced.

## Production order

1. Deploy the Spec app and MCP changes from the same commit.
2. Confirm `GET /api/projects/data-quality` works for an admin session.
3. Run `GET /api/aria-actions/sync` once as an admin. It is safe to repeat: open Office actions are matched by a stable automation key and refreshed rather than duplicated.
4. Check the Operations and Phillip Office groups:
   - critical Project Health and upcoming unconfirmed-booking actions are in Operations;
   - current 30/60/90 Potential Future Lead reviews are in Phillip;
   - Future Lead values remain excluded from the active pipeline total.
5. Trigger one daily review. Its queue payload must contain `phase_4_action_sync`, and a same-day second trigger must return `queued: false` without multiplying tasks.

No database migration or new environment variable is required.

## Mac mini

After production is healthy, Aria can install the MCP update herself:

```text
cd /Users/vale/reslu-spec-system
git pull --ff-only
node --check mcp/src/index.mjs
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

Then verify in a fresh OpenClaw session:

```text
Call get_project_health with no project_id. Report only the number of active projects, critical issues and warnings. Do not create, edit or send anything.
```

## Merge into OpenClaw standing instructions

Do not overwrite `AGENTS.md` or `HEARTBEAT.md`. Merge this rule:

> For daily and weekly reviews, call both `get_context_snapshot` and `get_project_health`. Phase 4 already creates or refreshes deduplicated Office actions for critical project/booking issues; investigate them without creating duplicates. Potential Future Lead is nurture only and never active pipeline value. You may research and draft proposed corrections or replies, but never apply project-data corrections, resend, contact a client/trade, or change a lead stage without Phillip's approval.

## Acceptance checks

1. Re-running the action sync does not add a second open Office task for the same automation key.
2. A completed Project Health action can be raised again on a later day only if the source issue still exists.
3. A Future Lead gets one current 30/60/90 reminder, and moving out then back into the stage starts a new cycle.
4. A signed Resend bounce/failure/delay for an open grouped booking raises a `trade_reminder` queue item immediately; it never resends automatically.
5. Project, item, booking and lead-stage records remain unchanged by the sync.
