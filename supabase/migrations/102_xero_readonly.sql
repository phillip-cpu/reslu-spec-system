-- Xero phase X1: encrypted connection metadata plus a read-only local
-- accounting cache. These tables deliberately have RLS enabled with no
-- client policies: only server-side service-role code may read or write
-- Xero tokens and imported accounting records.

create table if not exists xero_connections (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  text not null unique,
  tenant_name                text not null,
  tenant_type                text,
  access_token_encrypted     text not null,
  refresh_token_encrypted    text not null,
  access_token_expires_at    timestamptz not null,
  scopes                     text[] not null default '{}',
  is_active                  boolean not null default true,
  connected_by               uuid references profiles(id) on delete set null,
  connected_at               timestamptz not null default now(),
  last_refreshed_at          timestamptz,
  last_sync_started_at       timestamptz,
  last_sync_completed_at     timestamptz,
  last_sync_error            text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create unique index if not exists idx_xero_connections_one_active
  on xero_connections(is_active) where is_active;

drop trigger if exists trg_xero_connections_updated_at on xero_connections;
create trigger trg_xero_connections_updated_at
  before update on xero_connections
  for each row execute function set_updated_at();

create table if not exists xero_invoices (
  id                         uuid primary key default gen_random_uuid(),
  connection_id              uuid not null references xero_connections(id) on delete cascade,
  xero_invoice_id            text not null,
  invoice_type               text not null check (invoice_type in ('ACCREC', 'ACCPAY')),
  status                     text not null,
  invoice_number             text,
  reference                  text,
  contact_id                 text,
  contact_name               text,
  invoice_date               date,
  due_date                   date,
  currency_code              text,
  subtotal                   numeric(14,2),
  total_tax                  numeric(14,2),
  total                      numeric(14,2),
  amount_due                 numeric(14,2),
  amount_paid                numeric(14,2),
  amount_credited            numeric(14,2),
  updated_date_utc           timestamptz,
  raw_json                   jsonb not null,
  synced_at                  timestamptz not null default now(),
  unique (connection_id, xero_invoice_id)
);

create index if not exists idx_xero_invoices_direction_status
  on xero_invoices(connection_id, invoice_type, status);
create index if not exists idx_xero_invoices_number
  on xero_invoices(connection_id, invoice_number);
create index if not exists idx_xero_invoices_contact
  on xero_invoices(connection_id, contact_name);

create table if not exists xero_payments (
  id                         uuid primary key default gen_random_uuid(),
  connection_id              uuid not null references xero_connections(id) on delete cascade,
  xero_payment_id            text not null,
  xero_invoice_id            text,
  payment_type               text,
  status                     text,
  payment_date               date,
  amount                     numeric(14,2),
  bank_amount                numeric(14,2),
  currency_rate              numeric(18,8),
  is_reconciled              boolean,
  updated_date_utc           timestamptz,
  raw_json                   jsonb not null,
  synced_at                  timestamptz not null default now(),
  unique (connection_id, xero_payment_id)
);

create index if not exists idx_xero_payments_invoice
  on xero_payments(connection_id, xero_invoice_id);

create table if not exists xero_sync_runs (
  id                         uuid primary key default gen_random_uuid(),
  connection_id              uuid not null references xero_connections(id) on delete cascade,
  triggered_by               uuid references profiles(id) on delete set null,
  status                     text not null check (status in ('running', 'completed', 'failed')),
  started_at                 timestamptz not null default now(),
  completed_at               timestamptz,
  invoices_checked           integer not null default 0,
  payments_checked           integer not null default 0,
  error_message              text
);

create index if not exists idx_xero_sync_runs_recent
  on xero_sync_runs(connection_id, started_at desc);

alter table xero_connections enable row level security;
alter table xero_invoices enable row level security;
alter table xero_payments enable row level security;
alter table xero_sync_runs enable row level security;

comment on table xero_connections is
  'Service-role-only Xero OAuth connection. Token columns contain AES-256-GCM ciphertext, never plaintext.';
comment on table xero_invoices is
  'Read-only cache of Xero ACCREC sales invoices and ACCPAY purchase bills.';
comment on table xero_payments is
  'Read-only cache of Xero payments used to cross-check invoice balances.';
comment on table xero_sync_runs is
  'Durable operational audit of manual and scheduled Xero read synchronisations.';
