# Construction quote release and safe rollback

No command in this document is approval to change production.

## Ordered release

1. Review PR code and security changes, successful build/QA, backups and deployed database identity.
2. Keep `RESLU_CONSTRUCTION_QUOTES_ENABLED` absent (default off) in production and previews.
3. Verify the existing exact `profile_security_private.guard_profile_role_change`
   prerequisite from `supabase/release-dependencies/reused_profile_role_guard.sql`.
   It is not installed by the quote migration; absent or changed definitions require
   separate security review/approval, not blind replacement.
4. Confirm construction lifecycle migration `20261013000008` is installed. Apply
   quote migration `20261024000458` transactionally only after explicit approval.
   It installs restrictive quote policies, draft/identity trigger and readiness RPC
   together. Any failure rolls the entire transaction back; no partial enablement.
5. In an authenticated admin session verify `construction_quote_runtime_ready()`
   is true, non-admin returns false and anonymous execution is denied. A missing
   RPC, error, policy/guard drift or disabled RLS/trigger keeps API writes held.
6. Deploy approved app. After database/security verification, separately approve
   setting `RESLU_CONSTRUCTION_QUOTES_ENABLED=1`. Recheck admin create/edit and
   non-admin denial with a clearly synthetic record in an approved test project.
   No customer data/pricing/sends/signatures/payments are part of this task.
7. Keep all customer send/acceptance paths disabled. This feature is internal only.

## Rollback after any quote exists

- Immediately remove `RESLU_CONSTRUCTION_QUOTES_ENABLED`; create and PATCH fail
  closed while admin read/PDF remains available. Retain the current safe build if
  possible; operational disablement is preferred to an old-code redeployment.
- NEVER drop quote RLS policies, guard trigger, readiness RPC or profile-role guard
  to roll back the UI. Retain quote records and database protections. No destructive
  down migration is supplied. Database restore/downgrade requires separate review.
- NEVER deploy the unmodified pre-feature app: its public token renderer reads using
  service-role and bypasses RLS. An older UI MUST retain the quote-denial API/token
  compatibility patch, even with the environment gate off.
- `node scripts/build-quote-safe-rollback.mjs` generates and applies a compatibility
  patch against the pinned pre-feature commit in a disposable directory, then runs
  the public-token and send/resend/accept/draft regression tests against that source.
  It does not deploy or modify your checkout. Output:
  `../evidence/quote-first/quote-safe-rollback.patch`.
- Before an approved rollback, build/test that patched old-UI artifact and verify
  unauthenticated quote tokens remain 404, send/accept remain blocked, writes held,
  and direct Data API privacy remains enforced. A plain Git revert is NOT a safe
  rollback. This patch is specific to the documented base, not arbitrary releases.
