-- Preserve the human-approved Xero account mapping for every source line.
-- The existing account_code column remains a compact searchable summary.

alter table public.stuart_xero_draft_bills
  add column if not exists line_account_codes jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stuart_xero_draft_bills_line_account_codes_check'
      and conrelid = 'public.stuart_xero_draft_bills'::regclass
  ) then
    alter table public.stuart_xero_draft_bills
      add constraint stuart_xero_draft_bills_line_account_codes_check
      check (jsonb_typeof(line_account_codes) = 'array');
  end if;
end $$;

comment on column public.stuart_xero_draft_bills.line_account_codes is
  'Exact human-approved account mapping by immutable supplier source-line sort; service-role audit evidence only.';

notify pgrst, 'reload schema';
