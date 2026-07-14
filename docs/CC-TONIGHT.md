# Claude Code — install queue (from Fable, 13 Jul 2026)

Phillip will just say: "read docs/CC-TONIGHT.md and do it."

1. [RESOLVED 13 Jul — Phillip added aria@reslu.com.au as a Vercel team member (paid seat), deploys unblocked. SKIP the git-author steps below; optionally do the config change when he is back from China so the seat can be cancelled.] GIT AUTHOR / BLOCKED DEPLOY: Vercel refused the last deploy — commit authored as
   aria@reslu.com.au (not a team member; Phillip is NOT paying for a seat).
   On the mini: git config user.name "Phillip Introna"; git config user.email <Phillip's GitHub email>.
   Re-author the blocked commit (git commit --amend --reset-author --no-edit if it's the tip,
   otherwise rebase the offending range) and push. Confirm Vercel builds green.
2. Delete any remaining iCloud "* 2.*" / "* 2" conflict duplicates in the tree before committing.
3. Run migration 054 (052/053 appear live already — verify). Commit ALL current work
   including docs/BUILD-SPEC.md (it was lost once; it must be in git).
4. vercel.json: add the health cron line — {"path":"/api/health/check","schedule":"*/10 * * * *"}.
5. [FIXED LOCALLY IN PHASE 2 — DEPLOY/MIGRATION PENDING] Health no longer infers a
   visit-email cron run from an optional sent email. `system_job_runs` records every
   completion, including a valid no-op; the visit job now runs hourly so failed queued
   sends do not wait a day for retry. Apply migration 055 before deploying this code.
6. VAPID keys for web push: keygen one-liner + env vars (NEXT_PUBLIC_VAPID_PUBLIC_KEY,
   VAPID_PRIVATE_KEY) per docs/MINI-HEALTH-HANDOFF.md §6. Add to Vercel, redeploy.
7. On the mini, per docs/MINI-HEALTH-HANDOFF.md: install launchd heartbeat script,
   channel-status reporting (each WhatsApp group + email poller + calendar →
   report_channel_status), and the diagnostics runner loop (poll get_pending_diagnostics —
   there's one pending request from Phillip already waiting to complete).
8. [ROOT CAUSE FIXED IN COMMIT 6989b31; PHASE 2 HARDENING LOCAL — DEPLOY PENDING]
   Phillip had to force Aria to clear the queue because the original `wake_aria()` was
   a stub. It now calls `openclaw system event --mode now`, and the launchd job runs
   every 5 minutes. Phase 2 also counts abandoned picked-up rows and creates proactive
   daily/weekly review items. After deploy + Mac-mini pull, verify the Aria
   wake loop end-to-end: aria_queue stuck count was 232 → 56 today,
   so something is draining; make sure it keeps running unattended (launchd, not a
   terminal session), incl. after reboots.
9. After deploy, tell Phillip. His test lap: enable notifications (Mac + iPhone),
   tiler selection test on the board, test proposal send→sign→deposit draft,
   press Run diagnostics & repair.

Standing rules unchanged: you own git/migrations/deploys; agents write code and pause;
Aria drafts, humans approve.
