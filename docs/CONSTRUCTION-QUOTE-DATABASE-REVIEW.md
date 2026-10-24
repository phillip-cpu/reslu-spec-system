# Construction quote database integration — 24 October 2026

**Local remediation verified; production deployment remains unapproved.**

The original findings below are retained as history. Local migration draft `20261024000458_construction_quote_authorisation.sql` now closes both paths; it has only run in disposable synthetic PostgreSQL clusters.

Implementation commit `8c211339f03df93ca0372a1830c1eb991b9dc7c0` is preserved on `feat/precontract-construction-quotes`. The first follow-up added tests and findings; the subsequent local remediation adds the quote-only migration draft. Host reverified as Phillips-Mac-Studio.local. No production connection or visible browser was used.

## Environment and coverage

Pinned embedded-postgres 18.4.0-beta.17 and pg 8.16.3 in `/tmp/reslu-construction-db-deps`. Each test creates a fresh random-port cluster listening only on 127.0.0.1, random synthetic users/projects and password, then stops/removes it in finally. No external DB URL is accepted.

Applied the actual repository SQL for the proposals table (Part 1 of 051), shared profile-role guard, and construction lifecycle migration. Ancillary auth/profile/project/estimate/SOW tables use minimal synthetic fixtures. This is real PostgreSQL RLS/trigger testing, not a full Supabase/PostgREST/auth deployment and not proof of production schema state.

The actual quote POST and PATCH handlers run through a small query adapter translating their supported Supabase query vocabulary into parameterised SQL. PostgreSQL, not a row double, enforces predicates and updates. Timestamps retain microsecond precision.

## Verified

- Missing or altered shared profile guard aborts the lifecycle migration transaction.
- Admin route creates an empty construction_quote draft, zero deposit, no construction source digest.
- Repeated creation across independent connections returns the same record, without duplicate inserts.
- Two concurrent saves using the same updated_at produce exactly one HTTP 200 and one HTTP 409. Actual updated_at trigger advances the persisted version.
- Saving $1,234.56 ex GST persists $1,358.02 including GST and zero deposit.
- Non-admin PATCH is rejected by the API; changing quote kind through PATCH is rejected.
- Anonymous SQL cannot see quote records.
- Existing frozen construction rows remain inaccessible to non-admins and cannot be downgraded by admin updates.
- Construction database release gate remains false; events/outbox stay empty.

## Originally confirmed blockers (now fixed in the local draft)

1. `construction_proposal_admin_only` restricts only `content.kind = construction`. The legacy permissive policy therefore allows an authenticated non-admin to SELECT and UPDATE construction_quote rows directly. Reproduced with a synthetic designer connection.
2. The construction immutability trigger also protects only construction. That same designer can change a quote's kind to design and status to sent directly. This bypasses the API's quote guards and would make the record eligible for existing design lifecycle paths. No email/signature/invoice workers were invoked in the test.

Diagnostic assertions intentionally confirm these weaknesses; a passing test run **does not mean release is safe**. Do not deploy commit 8c21133 alone. A separately reviewed database change must restrict quote reads/writes, prevent kind conversion, and enforce draft-only quote status/zero deposit before any deployment. Add negative regression tests for these paths after implementing that protection. The original implementation alone remains unsafe to deploy. Quote policy and trigger remediation now exists locally only; production is unchanged.

## Remaining authenticated UI checks

When the shared browser is released, use an isolated local/staging app and synthetic project/accounts:

1. Admin opens Estimate → Versions; quote action is distinct from frozen construction proposal. Create from a project with no issued SOW/frozen estimate; verify no scope issue or source record mutation.
2. Edit every field, including drawing identifier/revision, multiline scope, exclusions, payment terms, T&Cs and decimals; save, reload and inspect private PDF. Compare GST and totals.
3. Discard/back/reopen and browser refresh with unsaved edits: verify warnings, saved state and no unexpected writes.
4. Rapid repeated create/save, slow response and retry after simulated network loss: verify one create per request and no lost edits.
5. Two signed-in tabs save the same draft: second save must show conflict and retain its text; confirm reload recovery.
6. Designer/staff and anonymous sessions must be refused by list/detail/create/edit/PDF APIs. Public quote token must return unavailable; send/resend/accept/draft endpoints must reject quote records even with a forced sent fixture.
7. After database remediation, repeat direct authenticated Data API access and kind/status downgrade attempts with real session JWTs.
8. Verify actual design proposal editing/preview remains unchanged, frozen construction stays immutable and release-disabled, and quote actions create no invoice/email/queue/signature/project-stage changes.
9. Check responsive layout, labels, keyboard navigation, error announcements, long-content PDF pagination and drawing readability.

No real Reddy project data, live T1 issue, external send, merge, push or deployment is part of these checks.

## Evidence and commands

`node --experimental-strip-types scripts/test-construction-quote-database.mjs`

`node --experimental-strip-types scripts/test-construction-database.mjs`

Logs: `../evidence/quote-first/database-integration.log` and `database-regression.log`.


## Local remediation proof

Migration draft adds two restrictive RLS policies (authenticated admin-only quote access; explicit anonymous quote denial), composed with existing policies. It does not widen any grants or change design/construction policies. The private quote trigger is SECURITY INVOKER with a fixed pg_catalog search path and no caller EXECUTE grants; it requires an existing admin profile actor for quote writes, including service-role writes.

Quote kind, identity, project, token and creation date cannot change; deletion is denied to preserve identity. Quotes must remain project-bound unsigned drafts with zero deposit, null viewed/sent/signature/PDF evidence and no frozen-construction digest. Design records cannot be converted into quotes. Existing design and frozen construction branches are unchanged. Applying the migration twice is tested. It checks the exact shared profile-role guard prerequisite and aborts rather than silently repairing existing quotes with incompatible lifecycle data. It must be applied transactionally, with separate deployment approval, before allowing this feature in a deployed app.

Final local results:

- **13 PostgreSQL quote scenarios passed**, including actual API create/save on a SQL adapter, independent-connection retries and stale-save contention.
- Authenticated designer SELECT returns zero quote rows; UPDATE and DELETE affect zero rows; INSERT raises a permission/RLS error.
- Admin attempts to remove/change kind, send/accept/close, change project/token, set deposit, or add signature/view/sent evidence all raise errors. Admin draft edits still succeed.
- A service-role connection without an admin actor cannot mutate quote contents; bypass-RLS does not bypass kind immutability.
- Anonymous SELECT returns no quote rows. Legacy design editing/status changes remain functional; conversion to a quote fails.
- **16 original construction PostgreSQL scenarios passed with the new migration installed**, including issuance/acceptance transactions, immutable evidence, concurrent approval, rollback and release gate shutdown.
- **28 application route/pricing/lifecycle tests passed** again.

Evidence: `../evidence/quote-first/database-authorisation.log`, `database-authorisation-regression.log`, `authorisation-route-tests.log`. All disposable clusters stopped and removed. No production database, migration history, security settings or browser session was touched. No application code changed during this remediation, so the prior successful build/DOM/PDF checks remain applicable. Authenticated full-stack/PostgREST/UI checks above are still outstanding.

## Real authenticated HTTP verification — 24 October

Completed without browser control using Supabase CLI 2.122.0 experimental native runtime (Apple silicon), with SUPABASE_HOME redirected to `/tmp/reslu-quote-auth-home` and a separate project under `/tmp/reslu-quote-auth-check`. Only Auth, REST and PostgreSQL were enabled; Studio, mail, realtime, storage, functions, analytics and pooler were excluded. No existing desktop runtime was installed or changed.

The actual built Next application ran on loopback port 31847, using only credentials emitted by this disposable local stack. Synthetic admin/designer users were created via real Auth admin APIs, then signed in with passwords. No route auth mocks, row doubles or SQL query adapters were used in this HTTP run.

**Six full-stack scenarios passed:**

1. Real Auth password sessions: designer create refused (403); admin create 201; duplicate request 200 with same ID.
2. Actual route → Supabase JS → PostgREST → PostgreSQL save: concurrent stale-version requests produce one 200 and one 409; $1,000.01 ex GST persists $1,100.01 inc GST.
3. Real designer JWT cannot read or update the quote through REST, and cannot create one; even admin JWT cannot downgrade quote kind/status.
4. Real SSR cookie session obtained by password sign-in can GET the admin quote endpoint successfully (200).
5. Admin PDF returns valid PDF bytes; designer PDF denied (403); public token page unavailable (404).
6. Actual send/resend/accept HTTP routes return 409. Scope count and construction event/outbox counts remain zero.

Harness: `scripts/test-construction-quote-http.mjs`. Evidence: `../evidence/quote-first/http-integration.log`, `http-app.log`, `authenticated-synthetic-quote.pdf`. App process stopped, native stack destroyed successfully, synthetic database/accounts removed, temporary credentials removed. No production credentials or records accessed.

The minimal synthetic application schema remains intentionally scoped to the proposal workflow; this is not an assertion that every unrelated app integration has been exercised. UI items still pending: navigation from Estimate → Versions, real browser field/save/reload behaviour, two-tab conflict presentation, browser back/refresh prompts, responsive layout, keyboard/accessibility and confirmation that surrounding design/construction screens remain unchanged. These can wait until the shared browser is released. API, real-session authentication, cookie access and direct Data API checks no longer require a runtime blocker.

The already rendered and visually reviewed synthetic proposal was saved as a private Library attachment: `libfile_084df77a9f4481918b47e4cbcef22118`, version 0, `Synthetic-Construction-Quote-Review.pdf`. It is synthetic visual review evidence, not a Reddy quote or a client-issued document.
