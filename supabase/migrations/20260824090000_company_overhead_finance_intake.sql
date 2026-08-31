-- Approval-bound non-project supplier invoices. A row is only created by the
-- R2 commit tool after the source packet is re-read and matches Phillip's
-- immutable task-artifact approval receipt.

alter table public.finance_recurring_commitments
  add column if not exists source_email_id uuid references public.emails(id) on delete restrict,
  add column if not exists source_attachment_id uuid references public.email_attachments(id) on delete restrict,
  add column if not exists overhead_duplicate_key text,
  add column if not exists approval_receipt_id uuid references public.aria_approval_receipts(id) on delete restrict;

create unique index if not exists finance_overhead_source_email_unique
  on public.finance_recurring_commitments(source_email_id)
  where source_email_id is not null;

create unique index if not exists finance_overhead_duplicate_key_unique
  on public.finance_recurring_commitments(overhead_duplicate_key)
  where overhead_duplicate_key is not null;

create unique index if not exists finance_overhead_approval_receipt_unique
  on public.finance_recurring_commitments(approval_receipt_id)
  where approval_receipt_id is not null;

comment on column public.finance_recurring_commitments.source_email_id is
  'Second Brain source for an approval-bound company-overhead one-time purchase draft.';
comment on column public.finance_recurring_commitments.overhead_duplicate_key is
  'SHA-256 business key over normalized supplier + invoice date + total minor units.';
comment on column public.finance_recurring_commitments.approval_receipt_id is
  'Exact Phillip approval receipt authorising this one-time Cockpit draft.';

insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, allowed_agent_slugs,
  approval_rule, verification_kind, idempotency_kind, rollback_kind, active
) values (
  'commit_company_overhead_finance_intake',
  'Finance',
  'Create one source-backed company-overhead Cockpit purchase draft after exact approval',
  'commit', 'R2', array['aria']::text[], 'exact-owner',
  'draft_record', 'natural-key', 'delete-draft', true
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
  active = excluded.active;

notify pgrst, 'reload schema';
