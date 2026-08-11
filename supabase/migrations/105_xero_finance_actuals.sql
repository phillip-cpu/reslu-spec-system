-- Xero cash snapshots for the company finance cockpit. Raw accounting data
-- remains service-role-only; the browser receives only the calculated cash
-- balance and aggregate sync metadata from an authorised server route.

create table if not exists xero_bank_accounts (
  id                         uuid primary key default gen_random_uuid(),
  connection_id              uuid not null references xero_connections(id) on delete cascade,
  xero_account_id            text not null,
  code                       text,
  name                       text not null,
  bank_account_type          text,
  status                     text,
  raw_json                   jsonb not null,
  synced_at                  timestamptz not null default now(),
  unique (connection_id, xero_account_id)
);

create table if not exists xero_cash_snapshots (
  id                         uuid primary key default gen_random_uuid(),
  connection_id              uuid not null references xero_connections(id) on delete cascade,
  as_of_date                 date not null,
  cash_balance               numeric(14,2) not null,
  credit_balance             numeric(14,2) not null default 0,
  report_date                text,
  raw_json                   jsonb not null,
  synced_at                  timestamptz not null default now(),
  unique (connection_id, as_of_date)
);

create index if not exists idx_xero_cash_snapshots_latest
  on xero_cash_snapshots(connection_id, as_of_date desc);

alter table xero_bank_accounts enable row level security;
alter table xero_cash_snapshots enable row level security;

revoke all on table xero_bank_accounts from public, anon, authenticated;
revoke all on table xero_cash_snapshots from public, anon, authenticated;
grant all on table xero_bank_accounts to service_role;
grant all on table xero_cash_snapshots to service_role;

comment on table xero_bank_accounts is
  'Service-role-only Xero account cache used to distinguish cash bank accounts from credit cards.';
comment on table xero_cash_snapshots is
  'Service-role-only daily Xero Bank Summary balance. cash_balance excludes CREDITCARD liabilities.';
