-- Company forecast entries can be either recurring commitments or one-time
-- expected outgoings. They share the existing audited register and projection
-- pipeline; frequency = 'once' emits one cashflow occurrence on first_due_date.

alter table finance_recurring_commitments
  drop constraint if exists finance_recurring_commitments_frequency_check;

alter table finance_recurring_commitments
  add constraint finance_recurring_commitments_frequency_check
  check (frequency in (
    'once', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'
  ));

alter table finance_recurring_commitments
  drop constraint if exists finance_recurring_commitments_category_check;

alter table finance_recurring_commitments
  add constraint finance_recurring_commitments_category_check
  check (category in (
    'wages', 'superannuation', 'rent', 'marketing', 'entertainment',
    'software', 'insurance', 'utilities', 'professional_fees', 'vehicles',
    'other'
  ));

comment on table finance_recurring_commitments is
  'Audited company-level recurring and one-time expected cash outgoings. frequency once emits a single forecast occurrence on first_due_date.';

notify pgrst, 'reload schema';
