-- Client contract billing and manual money-in records.
--
-- The contract examples supplied for this round use a fixed package paid
-- through named milestones. Construction: 30/20/20/20/10 and seven-day
-- terms. Design: five named fee stages and fourteen-day terms. Client
-- invoices therefore claim one package milestone; they do not itemise the
-- products or supplier costs inside that package. Approved variations are
-- presented separately from the original contract sum.

alter table client_invoices
  add column if not exists source text not null default 'reslu';

alter table client_invoices
  add column if not exists payment_schedule_item_id uuid;

alter table client_invoices
  add column if not exists contract_snapshot jsonb not null default '{}'::jsonb;

alter table client_invoices
  drop constraint if exists client_invoices_source_check;
alter table client_invoices
  add constraint client_invoices_source_check
    check (source in ('reslu', 'manual'));

create index if not exists idx_client_invoices_source
  on client_invoices(source, status)
  where deleted_at is null;

comment on column client_invoices.source is
  'reslu = invoice created, numbered and optionally sent by RESLU Spec. manual = an existing external invoice recorded for money-in tracking using its original invoice number and dates.';

comment on column client_invoices.contract_snapshot is
  'Point-in-time contract statement used by the PDF: original contract, approved variations, prior payments with dates, this package claim, future claims and remaining balance.';

create table if not exists client_billing_profiles (
  project_id               uuid primary key references projects(id) on delete cascade,
  contract_type            text not null default 'design'
                           check (contract_type in ('design', 'construction', 'other')),
  contract_label           text not null default 'Project package',
  contract_amount_inc_gst  numeric(12,2) not null default 0
                           check (contract_amount_inc_gst >= 0),
  due_days                 int not null default 14 check (due_days >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

drop trigger if exists trg_client_billing_profiles_updated_at on client_billing_profiles;
create trigger trg_client_billing_profiles_updated_at
  before update on client_billing_profiles
  for each row execute function set_updated_at();

alter table client_billing_profiles enable row level security;
drop policy if exists "team_all" on client_billing_profiles;
create policy "team_all" on client_billing_profiles
  for all to authenticated using (true) with check (true);

create table if not exists client_payment_schedule (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  label           text not null,
  percentage      numeric(7,4),
  amount_inc_gst  numeric(12,2) not null check (amount_inc_gst >= 0),
  milestone_date  date,
  sort            int not null default 0,
  client_invoice_id uuid references client_invoices(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

drop trigger if exists trg_client_payment_schedule_updated_at on client_payment_schedule;
create trigger trg_client_payment_schedule_updated_at
  before update on client_payment_schedule
  for each row execute function set_updated_at();

create index if not exists idx_client_payment_schedule_project
  on client_payment_schedule(project_id, sort)
  where deleted_at is null;

create unique index if not exists idx_client_payment_schedule_invoice
  on client_payment_schedule(client_invoice_id)
  where client_invoice_id is not null and deleted_at is null;

alter table client_payment_schedule enable row level security;
drop policy if exists "team_all" on client_payment_schedule;
create policy "team_all" on client_payment_schedule
  for all to authenticated using (true) with check (true);

alter table client_invoices
  drop constraint if exists client_invoices_payment_schedule_item_id_fkey;
alter table client_invoices
  add constraint client_invoices_payment_schedule_item_id_fkey
    foreign key (payment_schedule_item_id)
    references client_payment_schedule(id) on delete set null;

create unique index if not exists idx_client_invoices_schedule_item
  on client_invoices(payment_schedule_item_id)
  where payment_schedule_item_id is not null and deleted_at is null and status <> 'void';

comment on table client_billing_profiles is
  'One fixed client-facing package per project. Amounts are stored inclusive of GST to match signed RESLU design and construction contracts.';

comment on table client_payment_schedule is
  'Named package progress claims. A row can be linked to one client invoice; supplier/product line items are deliberately not represented here.';

comment on column client_invoices.payment_schedule_item_id is
  'The single contract package milestone claimed by this invoice.';

notify pgrst, 'reload schema';
