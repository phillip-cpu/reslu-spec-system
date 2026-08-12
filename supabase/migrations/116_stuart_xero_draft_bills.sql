-- Stuart's narrow Xero write ledger. This records draft-bill attempts and
-- supplier-statement checks without granting Stuart general finance-table or
-- Xero mutation access. Service-role only; API routes enforce Stuart identity.

create table if not exists stuart_xero_draft_bills (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references invoices(id) on delete restrict,
  xero_invoice_id     text,
  status              text not null check (status in ('creating', 'draft_created', 'complete', 'failed')),
  account_code        text not null,
  attachment_uploaded boolean not null default false,
  safe_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (invoice_id)
);

create table if not exists stuart_supplier_statement_reviews (
  id                  uuid primary key default gen_random_uuid(),
  supplier            text not null,
  statement_date      date not null,
  source_filename     text,
  invoice_count       integer not null check (invoice_count >= 0),
  missing_count       integer not null check (missing_count >= 0),
  mismatch_count      integer not null check (mismatch_count >= 0),
  result              jsonb not null,
  reviewed_by         uuid references profiles(id) on delete set null,
  created_at          timestamptz not null default now()
);

alter table stuart_xero_draft_bills enable row level security;
alter table stuart_supplier_statement_reviews enable row level security;
revoke all on table stuart_xero_draft_bills from public, anon, authenticated;
revoke all on table stuart_supplier_statement_reviews from public, anon, authenticated;
grant all on table stuart_xero_draft_bills to service_role;
grant all on table stuart_supplier_statement_reviews to service_role;

comment on table stuart_xero_draft_bills is
  'Idempotency and safe audit ledger for Stuart-created DRAFT ACCPAY bills only.';
comment on table stuart_supplier_statement_reviews is
  'Metadata and discrepancy results from supplier statements; statements never become Xero bills.';
