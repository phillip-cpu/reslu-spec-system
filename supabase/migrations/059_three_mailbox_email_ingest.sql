-- ============================================================
-- RESLU Second Brain — authoritative three-mailbox email ingest.
--
-- The Mac-mini worker now reads the already-authorised Aria, Phillip
-- and Tenille Gmail accounts. One RFC Message-ID can legitimately be
-- visible in more than one mailbox (for example Phillip sends a
-- message to Tenille), so provenance is stored as a set of mailbox
-- addresses plus a mailbox->Gmail-id map while the existing unique
-- message_id remains the canonical dedupe key.
--
-- Attachment SHA-256 is deliberately not unique: a forwarded email
-- should remain part of the correspondence record even when it carries
-- the exact same PDF. The hash is instead used to deduplicate the
-- downstream invoice-review queue before any financial proposal exists.
-- ============================================================

alter table emails
  add column if not exists ingested_mailboxes text[] not null default '{}'::text[],
  add column if not exists gmail_refs jsonb not null default '{}'::jsonb;

alter table email_attachments
  add column if not exists content_sha256 text;

create index if not exists idx_emails_ingested_mailboxes
  on emails using gin (ingested_mailboxes);

create index if not exists idx_email_attachments_content_sha256
  on email_attachments(content_sha256)
  where content_sha256 is not null;

comment on column emails.ingested_mailboxes is
  'Lowercase RESLU mailbox addresses in which this RFC Message-ID was observed by the Mac-mini ingest worker. A single canonical email row can reference multiple mailboxes.';

comment on column emails.gmail_refs is
  'Map of lowercase mailbox address to that mailbox''s Gmail message id. Contains identifiers only, never OAuth credentials or message content.';

comment on column email_attachments.content_sha256 is
  'SHA-256 of the original attachment bytes. Non-unique by design: forwarded copies remain stored, while invoice_candidate queue dedupe uses this hash to avoid duplicate review work.';

notify pgrst, 'reload schema';
