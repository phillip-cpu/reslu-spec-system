# Finance M2 handoff — recurring company commitments

## What this delivers

- Migration `081_finance_recurring_commitments.sql` creates the audited,
  company-level register for wages, superannuation, rent, marketing, software,
  insurance, utilities, professional fees, vehicles and other overheads.
- The Finance cockpit gains a **Recurring commitments** tab with create, edit,
  pause/draft and archive controls for users holding
  `finance.edit_forecast`.
- Active rules generate deterministic dated outflows for the existing 13-week
  shadow curve. Nothing is persisted as a projection and no missing dates are
  invented.

## Controlled rollout

1. In the Supabase SQL editor, run
   `supabase/migrations/081_finance_recurring_commitments.sql` after migration
   080. It is additive and ends with a PostgREST schema reload notification.
2. Deploy this branch with the existing preview flags:
   `FINANCE_FOUNDATION_ENABLED=true` and
   `FINANCE_SHADOW_PROJECTION_ENABLED=true`.
3. Sign in as an admin, open **Finance → Recurring commitments**, and add a
   small test rule. Suggested acceptance item: `$100`, weekly, first due today,
   active.
4. Return to **Cash timeline**. The dated outflow and closing cash should move
   by exactly `$100` in each applicable week. Opening cash remains a manual,
   non-persisted preview until the approved bank/Xero milestone.
5. Edit the amount and confirm the forecast changes. Archive the test rule and
   confirm it disappears from the register and cash curve.

## Accounting semantics

- `amount_minor` is always the cash amount per occurrence, stored in Australian
  dollar cents. `gst_treatment` records classification only; it does not add or
  remove GST behind the user's back.
- `first_due_date` is the recurrence anchor. A 31st-of-month monthly rule lands
  on the last valid day of short months and returns to the 31st when possible.
- Occurrences before `as_of_date` are expected to already be represented in
  opening cash and are not counted again.
- Optional escalation is stored in basis points and compounds on each anchor
  anniversary, rounded to integer cents.

## Verification completed locally

- Finance unit/contract suite: 26 tests passing.
- Finance-only TypeScript check: passing.
- Production build and browser acceptance should run after migration 081 is
  applied to the preview database.
