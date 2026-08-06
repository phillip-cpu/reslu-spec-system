# Finance Milestone 1 handoff

## Delivered

- Migration `080_finance_foundation.sql`: explicit capabilities, RLS,
  lifecycle profiles, immutable policies/baselines/events, minor-unit
  contributions and projection tables.
- Atomic `activate_project_finance(...)` with idempotency, optimistic
  concurrency, current program watermark and prerequisite revalidation.
- Controlled `publish_finance_policy(...)`; the seeded M0 policy remains
  a draft until owner, accountant and legal confirmations are supplied.
- Feature-flagged readiness, activation, project-finance and policy APIs.
- Non-persisting deterministic 13-week shadow projection.
- Responsive `/finance` cockpit with cash curve, weekly contribution drill-down,
  portfolio lifecycle table, coverage/source states and governance controls.
- Responsive `/projects/:id/finance` workspace with cost-section position,
  shadow timing editor, readiness evidence and atomic activation command.
- Finance navigation behind the foundation kill switch.
- Golden/invariant/access-contract tests under `lib/finance`.

## Local verification

- `npm run build`: passes, including both finance pages and seven finance API routes.
- `tsc -p tsconfig.finance.json --noEmit`: passes.
- Targeted ESLint over the finance routes, libraries and types: passes.
- `node --experimental-strip-types --test lib/finance/*.test.ts`: 18/18
  tests pass.
- `git diff --check`: passes.
- Desktop and 390px browser QA: cash-point drill-down and project-tab switching
  verified; a chart-strip overflow defect found in QA was corrected.

The broader `lib/*.test.ts` command still hits the existing extensionless
import in `lib/project-financial-position.test.ts` under Node's native ESM
runner. That file and its implementation were not changed by this milestone.

## Safe deployment order

1. Apply migration 080 to staging and confirm existing admins received
   bootstrap capability rows.
2. Leave both finance flags false; run the finance tests and inspect RLS
   with separate admin/designer/viewer test users.
3. Set `FINANCE_FOUNDATION_ENABLED=true` in staging only. Confirm the M0
   policy remains `draft` and activation readiness reports that gate open.
4. Record the owner, accountant and legal decisions. Publish the policy
   only through the controlled endpoint/function.
5. Enable `FINANCE_SHADOW_PROJECTION_ENABLED=true` in staging. Compare
   golden projects with hand calculations and verify unmapped timing is
   shown as unknown.
6. Activate only a synthetic/staging project. Verify baseline, forecast
   lines, activation event and audit event were created atomically.

## Deliberately deferred

- Production policy confirmation and production activation.
- Xero OAuth/read model (Milestone 2).
- Actual/commitment matching (Milestone 3).
- Cost-line-to-stage mapping, company opening cash and published cockpit
  projections (Milestone 4).
- Claims, scenarios and AI Finance Officer (later milestones).

Current estimate versions do not store cost-line stage timing. M1 does
not infer dates from descriptions or spread costs statistically; those
amounts remain `unknownTimingMinor` until an explicit mapping is built.
