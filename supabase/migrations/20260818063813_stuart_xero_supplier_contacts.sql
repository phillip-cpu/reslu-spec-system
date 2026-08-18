-- Controlled Xero contact creation for Stuart. The row is both an
-- idempotency reservation and a durable audit record. Only server-side
-- service-role code may access it; the API separately enforces Stuart identity
-- and exact human approval.

create table public.stuart_xero_supplier_contacts (
  id                  uuid primary key default gen_random_uuid(),
  connection_id       uuid not null references public.xero_connections(id) on delete restrict,
  source_invoice_id   uuid not null references public.invoices(id) on delete restrict,
  xero_contact_id     text,
  legal_name          text not null check (char_length(legal_name) between 2 and 255),
  tax_number          text not null check (tax_number ~ '^[0-9]{11}$'),
  status              text not null check (status in ('creating', 'created', 'failed')),
  safe_error          text,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (connection_id, source_invoice_id)
);

create unique index stuart_xero_supplier_contacts_created_tax_number_uq
  on public.stuart_xero_supplier_contacts (connection_id, tax_number)
  where status = 'created';

create unique index stuart_xero_supplier_contacts_created_name_uq
  on public.stuart_xero_supplier_contacts (connection_id, lower(legal_name))
  where status = 'created';

alter table public.stuart_xero_supplier_contacts enable row level security;
revoke all on table public.stuart_xero_supplier_contacts from public, anon, authenticated;
grant all on table public.stuart_xero_supplier_contacts to service_role;

comment on table public.stuart_xero_supplier_contacts is
  'Idempotency and audit ledger for source-backed Xero contacts created by Stuart with exact human approval; excludes bank details.';

insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, allowed_agent_slugs,
  approval_rule, verification_kind, idempotency_kind, rollback_kind, active
) values (
  'create_stuart_xero_supplier_contact',
  'Finance',
  'Create a verified source-backed Xero supplier contact without bank details',
  'commit',
  'R2',
  array['aria','stuart']::text[],
  'exact-owner',
  'provider_readback',
  'provider-key',
  'compensating-action',
  true
)
on conflict (tool_name) do update set
  owner = excluded.owner,
  purpose = excluded.purpose,
  action_class = excluded.action_class,
  risk_tier = excluded.risk_tier,
  allowed_agent_slugs = excluded.allowed_agent_slugs,
  approval_rule = excluded.approval_rule,
  verification_kind = excluded.verification_kind,
  idempotency_kind = excluded.idempotency_kind,
  rollback_kind = excluded.rollback_kind,
  active = excluded.active,
  updated_at = now();
