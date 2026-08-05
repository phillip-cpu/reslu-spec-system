-- New project FF&E items default to a 30% client markup. This changes
-- the default only: existing null/custom markup values are not backfilled
-- or rewritten, and reusable library prices remain cost-only.
alter table items
  alter column markup_pct set default 30;

comment on column items.markup_pct is
  'Project-specific FF&E client markup percent. New rows default to 30; existing values and intentional overrides are preserved.';

notify pgrst, 'reload schema';
