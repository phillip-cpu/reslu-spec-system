-- ============================================================
-- RESLU Spec System — Address Book insurance document requests.
--
-- A team member can send a contact a secure, expiring upload link.
-- The request records its own requested/opened/completed lifecycle;
-- uploaded contact_documents retain their normal compliance and
-- expiry behaviour while also pointing back to the request that
-- collected them.
-- ============================================================

create table if not exists contact_document_requests (
  id                uuid primary key default gen_random_uuid(),
  contact_id        uuid not null references contacts(id) on delete cascade,
  token             text not null unique default encode(gen_random_bytes(32), 'hex'),
  requested_kinds   text[] not null default array['public_liability', 'workers_comp']::text[],
  to_email          text not null,
  status            text not null default 'requested'
                    check (status in ('requested', 'opened', 'completed', 'cancelled')),
  requested_at      timestamptz not null default now(),
  sent_at           timestamptz,
  opened_at         timestamptz,
  completed_at      timestamptz,
  expires_at        timestamptz not null default (now() + interval '30 days'),
  provider_message_id text,
  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint contact_document_requests_kinds_nonempty
    check (cardinality(requested_kinds) > 0),
  constraint contact_document_requests_kinds_allowed
    check (requested_kinds <@ array['public_liability', 'workers_comp', 'licence']::text[])
);

create index if not exists idx_contact_document_requests_contact
  on contact_document_requests(contact_id, created_at desc);
create index if not exists idx_contact_document_requests_active
  on contact_document_requests(status, expires_at)
  where status in ('requested', 'opened');
create unique index if not exists idx_contact_document_requests_provider_message
  on contact_document_requests(provider_message_id)
  where provider_message_id is not null;

drop trigger if exists trg_contact_document_requests_updated_at on contact_document_requests;
create trigger trg_contact_document_requests_updated_at
  before update on contact_document_requests
  for each row execute function set_updated_at();

alter table contact_document_requests enable row level security;
drop policy if exists "team_all" on contact_document_requests;
create policy "team_all" on contact_document_requests
  for all to authenticated using (true) with check (true);

alter table contact_documents
  add column if not exists request_id uuid
    references contact_document_requests(id) on delete set null;

create index if not exists idx_contact_documents_request
  on contact_documents(request_id)
  where request_id is not null and deleted_at is null;

comment on table contact_document_requests is
  'Address Book insurance-document request lifecycle. The unguessable token gates the public upload page; requested/opened/completed timestamps give the studio an auditable status without requiring the trade to sign in.';
comment on column contact_documents.request_id is
  'The secure Address Book request that collected this document. NULL means the file was uploaded directly by the RESLU team.';

-- email_sends is the shared Resend delivery ledger. Widen its
-- polymorphic discriminator so delivery/open/bounce webhooks can be
-- attached to the exact insurance request email.
alter table email_sends
  drop constraint if exists email_sends_record_type_check;
alter table email_sends
  add constraint email_sends_record_type_check
    check (
      record_type in (
        'lead',
        'client_event',
        'client_invoice',
        'trade_booking_request',
        'proposal',
        'contact_document_request'
      )
    );

comment on column email_sends.record_type is
  'Polymorphic reference discriminator. contact_document_request -> contact_document_requests.id for Address Book insurance upload requests; the other values retain their existing mappings.';

notify pgrst, 'reload schema';
