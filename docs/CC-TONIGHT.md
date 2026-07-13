# Claude Code — install queue (from Fable, 13 Jul 2026)

Phillip will just say: "read docs/CC-TONIGHT.md and do it."

1. GIT AUTHOR / BLOCKED DEPLOY: Vercel refused the last deploy — commit authored as
   aria@reslu.com.au (not a team member; Phillip is NOT paying for a seat).
   On the mini: git config user.name "Phillip Introna"; git config user.email <Phillip's GitHub email>.
   Re-author the blocked commit (git commit --amend --reset-author --no-edit if it's the tip,
   otherwise rebase the offending range) and push. Confirm Vercel builds green.
2. Delete any remaining iCloud "* 2.*" / "* 2" conflict duplicates in the tree before committing.
3. Run migration 054 (052/053 appear live already — verify). Commit ALL current work
   including docs/BUILD-SPEC.md (it was lost once; it must be in git).
4. vercel.json: add the health cron line — {"path":"/api/health/check","schedule":"*/10 * * * *"}.
5. INVESTIGATE: Health page shows visit-emails cron (confirmations/reminders) as never-run.
   Check the vercel.json entry, the route auth, and Vercel cron logs. Clients may have
   missed reminder emails.
6. VAPID keys for web push: keygen one-liner + env vars (NEXT_PUBLIC_VAPID_PUBLIC_KEY,
   VAPID_PRIVATE_KEY) per docs/MINI-HEALTH-HANDOFF.md §6. Add to Vercel, redeploy.
7. On the mini, per docs/MINI-HEALTH-HANDOFF.md: install launchd heartbeat script,
   channel-status reporting (each WhatsApp group + email poller + calendar →
   report_channel_status), and the diagnostics runner loop (poll get_pending_diagnostics —
   there's one pending request from Phillip already waiting to complete).
8. Verify the Aria wake loop end-to-end: aria_queue stuck count was 232 → 56 today,
   so something is draining; make sure it keeps running unattended (launchd, not a
   terminal session), incl. after reboots.
9. After deploy, tell Phillip. His test lap: enable notifications (Mac + iPhone),
   tiler selection test on the board, test proposal send→sign→deposit draft,
   press Run diagnostics & repair.

Standing rules unchanged: you own git/migrations/deploys; agents write code and pause;
Aria drafts, humans approve.
