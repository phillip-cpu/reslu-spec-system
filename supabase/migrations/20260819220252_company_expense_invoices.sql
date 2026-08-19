-- Company-level supplier invoices such as office rent, electricity, water,
-- internet and software belong in Spec without being assigned to a renovation
-- project. They share the existing evidence, duplicate and Xero-draft pipeline,
-- but are deliberately excluded from project actuals and approval functions.

alter table public.invoices
  alter column project_id drop not null;

alter table public.invoices
  add column if not exists expense_scope text not null default 'project',
  add column if not exists company_expense_category text,
  add column if not exists recurring_commitment_id uuid
    references public.finance_recurring_commitments(id) on delete set null,
  add column if not exists currency_code text;

update public.invoices
set currency_code = 'AUD'
where currency_code is null;

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
  );

alter table public.invoices
  drop constraint if exists invoices_currency_code_check;
alter table public.invoices
  add constraint invoices_currency_code_check check (
    currency_code is null or currency_code ~ '^[A-Z]{3}$'
  );

create index if not exists idx_invoices_company_queue
  on public.invoices(invoice_date desc, created_at desc)
  where expense_scope = 'company';

create index if not exists idx_invoices_recurring_commitment
  on public.invoices(recurring_commitment_id, invoice_date desc)
  where recurring_commitment_id is not null;

create unique index if not exists idx_invoices_company_number_amount_date_live
  on public.invoices (
    lower(btrim(supplier)),
    lower(btrim(invoice_number)),
    amount_ex_gst,
    coalesce(invoice_date, date '0001-01-01')
  )
  where expense_scope = 'company'
    and status not in ('rejected', 'voided');

comment on column public.invoices.expense_scope is
  'project invoices affect renovation actuals; company invoices are office/overhead bills shown in Finance and never affect a project.';
comment on column public.invoices.company_expense_category is
  'Required finance category for company-scoped supplier invoices.';
comment on column public.invoices.recurring_commitment_id is
  'Optional link from an actual company bill to its planned recurring commitment.';
comment on column public.invoices.currency_code is
  'ISO 4217 source-document currency. NULL means the source currency is unresolved and Xero draft creation must stop.';

notify pgrst, 'reload schema';
