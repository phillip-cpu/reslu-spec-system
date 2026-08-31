-- A genuine supplier bill may arrive before RESLU knows whether it belongs to
-- a renovation project or to company operations. Preserve it as unallocated
-- evidence so Stuart can create a guarded Xero DRAFT, then classify it later.

alter table public.invoices
  drop constraint if exists invoices_expense_scope_check;

alter table public.invoices
  add constraint invoices_expense_scope_check check (
    (expense_scope = 'project'
      and project_id is not null
      and company_expense_category is null
      and recurring_commitment_id is null)
    or
    (expense_scope = 'company'
      and project_id is null
      and company_expense_category in (
        'wages', 'superannuation', 'rent', 'marketing', 'entertainment',
        'software', 'insurance', 'utilities', 'professional_fees',
        'vehicles', 'other'
      ))
    or
    (expense_scope = 'unallocated'
      and project_id is null
      and company_expense_category is null
      and recurring_commitment_id is null)
  );

create index if not exists idx_invoices_unallocated_queue
  on public.invoices(invoice_date desc, created_at desc)
  where expense_scope = 'unallocated'
    and status not in ('rejected', 'voided');

comment on column public.invoices.expense_scope is
  'project invoices affect renovation actuals; company invoices are confirmed overheads; unallocated invoices are verified supplier bills awaiting a later project-or-company classification.';

notify pgrst, 'reload schema';
