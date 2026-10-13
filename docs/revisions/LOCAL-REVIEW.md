# Job revision workspaces — local implementation review

Status: implemented locally on `feat/construction-proposals`; local review changes. No push, deployment, live migration, role/access change, customer message, signature, payment or live V3 creation.

## Behavior

The existing Estimate page has a feature-gated **Job revisions** link. An admin chooses a complete frozen version, reads its estimate/FF&E/measurements/scope/payment drafts, and creates an independently editable working revision. Legacy slim estimate snapshots deliberately cannot be forked as a full job.

- Full frozen payload and exact sent-PDF reference/digest live inside the existing `estimate_versions.snapshot.full_job_revision`. The database protects frozen versions from update/delete.
- One `job_revision_workspaces` row owns each working version. All estimate lines, sections, items, measurements, scope document/sections/lines, allocations, components, allowance notes, options and payment drafts get new IDs. `origin_id` binds comparison to the original; room links and trade-display headings are preserved.
- EstimateView and MeasurementsView use a scoped data adapter. Scope uses the existing SowBuilder SectionBlock. FF&E fields reuse SpecRegister's EditableCell. Existing project editors continue to use their normal transport.
- Draft edits stay local until **Save working revision**. Cancel restores the last saved workspace. Switching revisions/back prompts before discarding committed draft edits. Database saves require source hash and expected counter. Repeated requests return the original result; stale competing saves fail without overwriting.
- Invoices, orders, source payments, accounting links and actuals are not cloned or written. The frozen baseline retains historical values; the project remains authoritative for actual accounting. The revision has no send/issue/accept/payment/order workflow.
- The scope clone is contained in the private workspace payload, with its own new document ID. It is edited using the existing scope blocks and does not insert or mark the original native T1 as issued. Publishing a future native SOW/proposal remains a separate approved action.
- Allowance notes refer to amounts already included in estimate lines; editing a note does not silently add it again. Options remain separate. Payment drafts may be saved incomplete but are prominently marked not ready until their percentages total 100%; nothing reallocates a shortfall.

## Phillip's variation pricing rule

`priceRevisionVariation` preserves the original job's dollar profit on omissions. Removed/reduced work credits cost only. Added cost receives the current applicable trade markup or item's FF&E markup. Calculations are ex GST; GST is added separately. The workspace shows the variation-priced selling total and retained/added/resulting profit, and payment amounts use that variation-priced total. The normal estimate recalculation remains labelled separately so an omission cannot disguise a reduction in original profit.

Test example: baseline cost $400,000 + $80,000 profit. Remove a $5,000-cost window: selling decreases $5,000 ex GST; profit stays $80,000. Add a $2,000-cost door at 20%: profit increases $400. Mixed change is a $2,600 ex GST credit and $80,400 profit. The rule is a pricing calculation, not customer acceptance or a claim of contract/legal compliance.

## Validation

- `node --experimental-strip-types scripts/test-job-revisions.mjs`: independent IDs/relationships, exact baseline selling totals, source isolation, FF&E/measurement/scope changes, invalid edit rollback, blocked live endpoints, 95.5% schedule, full payload round-trip, retained-profit examples.
- `node --experimental-strip-types scripts/test-job-revision-database.mjs`: disposable loopback PostgreSQL; role-guard prerequisite/transaction rollback, release gate OFF, immutable and idempotent baseline, concurrent/repeated fork and save, stale counter conflict, non-admin/anonymous/service-role denial, direct-write denial, profile self-promotion prevention, invalid payload rollback, source-identity/relationship checks, no accounting/notification changes.
- `node --experimental-strip-types scripts/test-job-revision-routes.mjs`: actual route/access code with synthetic database; authorization before financial reads, gate before DB access, cross-project/unknown revision rejection.
- `node --experimental-strip-types scripts/test-job-revision-ui.mjs`: actual React components in isolated headless Chrome with only synthetic API; frozen read-only, repeated click, edit/cancel, conflict/retry, 95.5% validation, navigation cancellation, V2 unchanged, scope display, no unexpected live API calls.
- Targeted ESLint and `npm run build -- --webpack`. Default Turbopack cannot use this checkout's existing out-of-root node_modules symlink; webpack is the tested build path. Old duplicate generated `.next` files were moved to the private evidence folder before a clean build.

The private Hone archive was also checked offline (never seeded into the test database): 20 sections, 118 active cost lines, 99 active FF&E items, 19 scope sections, 394 scope lines, $496,863.99 inc GST. New IDs/links survive JSON round-trip. Exact sent PDF: 369,590 bytes, SHA-256 `df04737ccec88909854be09808a52f74e25884c11498c62d25c77f504db3c4cb`. This is an archive check, not fresh production drift verification.

## Release approval gates

1. Review/approve this code and the candidate `20261013031531_job_revision_workspaces.sql`. Review the existing exact shared profile-role guard dependency; do not replace it with a competing guard. Candidate requires it and fails closed if changed. No live access changes are authorized by this local build.
2. Immediately before import, compare fresh read-only project/scope/financial hashes against the reviewed archive. Stop on drift. Review the full import payload, explicit source SOW, sent-PDF hash and import label. The checked private `reviewed-revision-import-input.json` is an offline assembly candidate; the unverified BBQ/benchtop questions have not been added to pricing. Allowance amounts remain in their source estimate lines.
3. Approve storage of the exact sent PDF in the existing private project files bucket. Freeze its project-scoped `storage_path` together with byte count/hash. The read-only PDF route verifies bytes before returning them; mismatches fail closed. A Library-only reference remains visible but cannot be opened through Spec until the private artifact is registered. Never regenerate or replace the sent PDF.
4. Apply the additive migration transactionally, with the release gate OFF. Deploy reviewed API/UI separately with `JOB_REVISION_WORKSPACES_ENABLED` OFF. Verify existing project/client flows and admin/non-admin checks in the target environment. Candidate migration is single-use; do not rerun it manually after success.
5. Only after approval enable the database gate and server flag. Under an authenticated admin identity, call `freeze_job_revision(project,label,snapshot,frozen,expected_hash)` with the reviewed assembler output. `expected_hash` must equal the SHA-256 of PostgreSQL's JSONB text representation of `frozen`, calculated in the controlled release session; do not substitute ordinary JSON.stringify hashing. The snapshot must be exactly the assembler's derived snapshot. Retrying the same label/source is idempotent; a different source is rejected.
6. Read back the frozen payload/hash and source PDF; recalculate the baseline using the existing estimate math. Then call `fork_job_revision` once with a fresh request UUID and the selected label. Read back and verify cloned IDs, relationships, totals and source immutability. Do not issue anything or modify live project estimate/receivables as part of this step.
7. Customer release/acceptance, publication to native SOW/proposal flows, and any legal contract text require their own review/approval. Approved post-contract variation history remains in the existing proposal/variation infrastructure.

## Rollback

Before any import, a failed migration rolls back its transaction. After successful use, disable the server flag and database release gate to stop new writes; retain frozen/workspace/history rows and original files. Do not drop or rewrite the immutable baseline as a rollback. A failed edit leaves the last saved revision intact; use Cancel/Reload after reviewing a concurrency error. A future production release should back up the candidate tables before enabling them.

No approved production release has occurred.

## Release baseline reconciliation

GitHub main was freshly fetched at `88a19381f3307bfccd45b1fd6e6226d07a6d9250`. The actual live baseline is `2a004068ff7f760264b6ac29b07900eb951f0742`; its GitHub Vercel status is success for deployment `HiTtehCy6xvzExT3a7fKZUE7t2pX`. That baseline contains `fff8dc3`, `1e4b21c`, and `2a00406`, affecting 12 finance/Stuart files. A coordinated candidate MUST retain all three commits. A deployment directly from the original main-based feature checkout would regress live finance and is prohibited.

### Independently releasable presentation subset

The pure `ProposalPdf` renderer, optional `ProposalReveal.proposalLabel`, proposal types, `SowPdf` display-name helper and optional type field can be released without database changes. They preserve current design-proposal behavior and default scope trade labels. They do not enable construction issue/acceptance, persisted heading edits, or V3.

### Features still gated

- Per-room heading editing requires `20261013000529_sow_trade_display_heading_overrides.sql`. Its API reads the new column, so do not ship the editor/API alone against a database without that migration.
- Construction issue/acceptance requires the existing candidate lifecycle migration, exact shared profile-role guard and a separately reviewed production enablement path; its current app gate intentionally permits local development/test only. No production env flag can bypass that gate.
- V3 requires `20261013031531_job_revision_workspaces.sql` and the exact shared profile-role guard; database and server flags default off. Its data import and exact private PDF registration are separate controlled steps.
- Coordinate one integrated release with the parent; the Tenille candidate is separate. No competing main push or deployment has been made from this task.

Final check results: 10 model/pricing checks, 10 real PostgreSQL checks, 4 API check groups, 4 headless UI check groups, 10 existing construction unit tests, 12 existing construction route tests, targeted lint and clean webpack build all passed. Evidence logs are stored outside Git in `../evidence/revision-verification/`.
