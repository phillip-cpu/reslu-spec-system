# RESLU Spec System — Disaster Recovery Runbook

Phase 14A (BUILD-SPEC.md Phase 14 "Backups"). One page, meant to be
readable under pressure — if the app or database is down and you're
reading this to fix it, skip straight to "Restore procedure" below.

This system has TWO independent backup layers:

1. **Supabase's own managed backups** (Dashboard → Database →
   Backups) — daily automatic backups on the Pro plan, plus optional
   Point-In-Time Recovery (PITR) if enabled. This is the FASTEST
   restore path for almost every real incident (accidental delete, bad
   migration, data corruption) and should always be tried first.
2. **The offsite mirror on the mini** (`scripts/backup-offsite.mjs`,
   weekly) — a second, independent copy on different infrastructure,
   for the rarer case where Supabase itself is unreachable (account
   lockout, billing lapse, regional outage, or Supabase support is
   simply too slow for an urgent need).

Both matter: layer 1 alone means "if Supabase has a bad day, so do
you." Layer 2 alone (weekly) means losing up to a week of data on a
routine incident that Supabase's own daily backups would have covered
in minutes. Use layer 1 first; layer 2 is the safety net.

---

## 1. Confirm Supabase backups are actually on

Do this NOW, before you ever need it (also listed in ROADMAP.md's "Do
immediately" section):

1. Supabase Dashboard → your project → **Database → Backups**.
2. Confirm daily backups are enabled (Pro plan required — the free
   tier has no backup guarantee and pauses after 7 days of
   inactivity, per BUILD-SPEC.md).
3. Consider the **PITR (Point-In-Time Recovery)** add-on if the
   business can't tolerate losing up to a day of changes on a bad
   incident — it lets you restore to any point in the last N days,
   not just the nightly snapshot.
4. Note the retention window shown on that page (e.g. 7/14/30 days) —
   write it here once confirmed: `_____________`.

## 2. Restore the database from Supabase's backup / PITR

**When to use:** any data-integrity incident where Supabase itself is
reachable — this is almost always the right first move.

1. Supabase Dashboard → **Database → Backups**.
2. Pick the backup point (a nightly snapshot, or a PITR timestamp if
   enabled) closest to — but before — the incident.
3. Follow Supabase's in-dashboard restore flow. Note: restoring
   **replaces** the current database state — if you need to keep
   anything written AFTER the incident but BEFORE the restore, export
   it first (Supabase's SQL editor, or `pg_dump` against the live DB)
   so it can be manually reapplied afterwards.
4. Once restored, verify: log in as a team member, open a project,
   confirm items/portal/estimate data looks right, check `updated_at`
   timestamps make sense.

**If Supabase itself is down/unreachable** (the rare case this
runbook's offsite layer exists for): restore from the mini's mirror
instead — see §4 below — into a NEW Supabase project, then re-point
env vars (§3).

## 3. Re-point environment variables (new/restored Supabase project)

Only needed if you ever restore into a **different** Supabase project
(new project ref, new URL) rather than restoring in place:

1. Supabase Dashboard (new project) → Settings → API — copy the new
   `Project URL`, `anon public` key, and `service_role` key.
2. Update **Vercel** (production env vars, not `.env.local` — that
   file never leaves a machine per BUILD-SPEC.md):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Update `.env.local` on the mini (by hand — it's git-ignored and
   never committed) with the same three values, so any local
   scripts/automations (backup script, Aria's MCP server, launchd
   jobs) keep working.
4. Re-run the migrations (`supabase/migrations/001_...` through the
   latest) against the new project if it's not already a restore of a
   full pg_dump (a `pg_dump`/`pg_restore` cycle brings the schema with
   it; a fresh empty project does not).
5. Re-create the two Storage buckets (`assets` private, `item-images`
   public — see `supabase/migrations/009_assets_bucket.sql` for the
   exact bucket config) if restoring into a schema-only fresh project,
   then restore objects from the mini's mirror (§4).
6. Redeploy on Vercel (env var changes require a redeploy to take
   effect in most cases — trigger one explicitly, don't assume the
   next git push will be soon enough).

## 4. Restore storage from the mini's offsite mirror

The mirror lives at `$BACKUP_ROOT` on the mini (default
`~/reslu-backups` — see `scripts/backup-offsite.mjs`'s header), one
folder per ISO week (e.g. `2026-W27/`), each containing:

- `manifest.json` — every object's bucket, path, size, etag, and
  when it was last downloaded (or `error` if a download failed that
  week — check this before trusting a restore is complete).
- `storage/<bucket>/<path>` — the actual files, mirrored 1:1 against
  Supabase Storage's own path structure.
- `db-<timestamp>.sql.gz` — a full `pg_dump` of the database, IF
  `pg_dump` was available on the mini and `SUPABASE_DB_URL` was set
  when that week's backup ran (check `manifest.json`'s `database.ran`
  field — it's `false` with a `reason` if that week skipped the DB
  dump).

**To restore storage objects:**

1. Pick the most recent week's folder (or an earlier one if you need
   to recover a since-deleted file — the manifest's `downloaded_at`
   per object tells you how current each individual file was as of
   that week's run).
2. For each bucket, re-upload the mirrored files to the (new or
   restored) Supabase project — either via the Supabase Dashboard's
   Storage UI (drag-and-drop, fine for a handful of files) or a small
   ad-hoc script using `@supabase/supabase-js`'s
   `storage.from(bucket).upload(path, fileBytes)` for bulk restores
   (mirror `scripts/backup-offsite.mjs`'s own upload/download calls —
   it's the same API in reverse).
3. Cross-check row counts / spot-check a few `storage_path` values
   from the restored database (item_files, project_files, site_photos,
   signature_events, etc.) against what actually exists in Storage
   post-restore — a DB restore and a Storage restore from two
   different points in time can disagree about what SHOULD exist.

**To restore the database from a `.sql.gz` dump** (only if Supabase's
own backup/PITR is unavailable — otherwise prefer §2):

```bash
gunzip -c ~/reslu-backups/2026-W27/db-<timestamp>.sql.gz | \
  psql "postgresql://postgres:<password>@<new-project>.supabase.co:5432/postgres"
```

Then re-create the two Storage buckets and follow the storage-restore
steps above.

## 5. Rotate keys after any incident involving possible credential exposure

If the incident involved a leaked/compromised key (service role key,
anon key, or the client_token/confirm_token trust model itself being
questioned):

1. Supabase Dashboard → Settings → API → regenerate the
   `service_role` key (and the `anon` key if that's also in question).
2. Update Vercel env vars + the mini's `.env.local` with the new
   values (same steps as §3.2–3.3).
3. Redeploy on Vercel.
4. Portal/trade tokens (`projects.client_token`,
   `trade_visits.confirm_token`) are per-row, not a shared secret — a
   single compromised link doesn't expose others. If a specific
   project's portal link needs rotating, use the in-app "Regenerate
   link" action (Settings → project → portal management) rather than
   a database-wide rotation.
5. If Monday.com or Gmail credentials were exposed: rotate in
   Monday.com / Google Cloud Console respectively, update `.env.local`
   on the mini (these are never read by the deployed Vercel app itself
   — see `.env.local.example`'s comments).

## 6. Test procedure checklist (run once now, then quarterly — §7)

- [ ] Confirm Supabase daily backups are ON (§1).
- [ ] Confirm `scripts/backup-offsite.mjs` has run successfully at
      least once — check `~/reslu-backups/<latest week>/manifest.json`
      exists and `storage_summary.failed` is 0 (or acceptably small).
- [ ] Confirm the launchd job is actually installed and scheduled
      (§8) — `launchctl list | grep reslu` should show it.
- [ ] Do a DRY restore of the database backup into a scratch/throwaway
      Supabase project (or a local Postgres instance) — confirm
      `pg_restore`/`psql` completes without fatal errors and a spot
      table (e.g. `items`) has the expected row count.
- [ ] Restore a handful of Storage objects from the mirror into a
      scratch bucket — confirm the files open correctly (not
      corrupted, correct content-type).
- [ ] Confirm you personally know where `.env.local`'s real values
      are recorded outside of any single machine (password manager /
      Phillip — never committed, per BUILD-SPEC.md) in case the mini
      itself is the thing that's lost.

## 7. Quarterly restore drill

Every quarter (calendar reminder — Settings → System health is a good
place to also eyeball recent `app_errors`, see below):

1. Run through the Test procedure checklist above in full, not just
   the "is it running" boxes — actually restore into a scratch
   project/bucket.
2. Time how long a full restore takes (DB + storage) — if it's grown
   uncomfortably slow (bigger dataset, mini's disk/network degraded),
   that's a signal to revisit RETENTION_WEEKS or the mini's hardware
   before an actual incident forces the question.
3. Confirm `RETENTION_WEEKS` (currently 8, in
   `scripts/backup-offsite.mjs`) still matches the business's actual
   tolerance for "how far back do we need to be able to go" — adjust
   the constant if not.
4. Check disk space on the mini (`df -h`) — the mirror grows with
   every new site photo/document/signed PDF; 8 weeks of incremental
   snapshots (unchanged files are hardlinked... actually NO — see
   note below) should be checked isn't silently filling the disk.
5. File a one-line note (date + result) somewhere durable (a
   Settings-page note, or a shared doc) so "when did we last actually
   test this" is never a guess.

**Disk space note:** `scripts/backup-offsite.mjs`'s incremental logic
skips downloading UNCHANGED files on a re-run, but each week's
`storage/` folder is currently a full standalone copy (not
hardlinked/deduplicated against the previous week) — so 8 weeks of
mirrors is roughly 8× the storage footprint, not 1×. This is a
deliberate simplicity trade-off for a zero-dependency script; if the
storage footprint ever gets large enough to matter, the next
iteration should either (a) keep a single rolling mirror directory
(no per-week folders for the `storage/` contents, only for
`manifest.json`/`db-*.sql.gz`) or (b) hardlink unchanged files between
week folders on filesystems that support it.

## 8. launchd — weekly scheduled run (the mini)

Create `~/Library/LaunchAgents/com.reslu.backup-offsite.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.reslu.backup-offsite</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/aria/reslu-spec-system/scripts/backup-offsite.mjs</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NEXT_PUBLIC_SUPABASE_URL</key>
    <string>https://your-project-ref.supabase.co</string>
    <key>SUPABASE_SERVICE_ROLE_KEY</key>
    <string>your-service-role-key-here</string>
    <key>SUPABASE_DB_URL</key>
    <string>postgresql://postgres:your-password@your-project-ref.supabase.co:5432/postgres</string>
    <key>BACKUP_ROOT</key>
    <string>/Users/aria/reslu-backups</string>
  </dict>

  <!-- Weekly, Monday 03:00 — quiet hours, before the team's day
       starts. Adjust Weekday (0=Sunday) and Hour to taste. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/aria/reslu-backups/backup-offsite.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/aria/reslu-backups/backup-offsite.error.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

Adjust the two file paths (`/Users/aria/reslu-spec-system/...` and
`/usr/local/bin/node`) to match the mini's actual clone location and
`which node` output. Then:

```bash
launchctl load ~/Library/LaunchAgents/com.reslu.backup-offsite.plist
launchctl list | grep reslu          # confirm it's loaded
launchctl start com.reslu.backup-offsite   # optional: run once immediately to test
```

Real credentials belong in the plist's `EnvironmentVariables` block on
the mini ONLY (this file itself, once filled in with real values,
should never be committed to the repo — treat it like `.env.local`).

## 9. Error visibility (uptime + error monitoring)

BUILD-SPEC.md Phase 14 also calls for "uptime + error monitoring."
This build's zero-dependency approach (see `lib/report-error.ts` and
the admin Settings → **System health** section) logs the last 50
server-side errors from the highest-value catch blocks (PDF route,
scrape pipeline, Monday sync, Gmail send, signature route) to a plain
`app_errors` table — enough to notice "something's been failing
repeatedly" during a normal admin check-in.

**This is NOT a substitute for real uptime monitoring** (nothing here
alerts anyone if the whole site goes down, since a down site can't log
to its own database). If/when this needs to grow up:

- **Sentry** (or a similar APM/error-tracking SaaS) is the documented
  upgrade path — full stack traces, source maps, release tracking,
  and push alerts (Slack/email) on new error types, replacing
  `lib/report-error.ts`'s rate-limited DB inserts. Deliberately NOT
  added as a dependency in this pass (BUILD-SPEC.md: "prefer zero"
  new deps) — Settings → System health documents this as the upgrade
  path in-app too.
- **Uptime monitoring** (UptimeRobot, Better Uptime, Vercel's own
  monitoring, or similar) hitting a simple health-check URL every few
  minutes is a cheap addition independent of Sentry — worth doing
  regardless of whether/when Sentry gets added.
