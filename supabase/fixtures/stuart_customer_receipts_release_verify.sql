-- Rollback-only release verifier. Uses synthetic rows in TEMP copies of the
-- installed schema, never actual profiles, approval receipts or action ledgers.
-- Run the WHOLE file in one database connection. Success ends in ROLLBACK.
-- LIKE INCLUDING ALL retains the installed checks/defaults/unique indexes;
-- it does not copy foreign keys, RLS, triggers or PostgREST permissions.
begin;
set local statement_timeout = '10s';
set local lock_timeout = '2s';
set local search_path = public, extensions, pg_temp, pg_catalog;

create temporary table receipt_review_registry
  (like public.aria_tool_registry including all) on commit drop;
create temporary table receipt_review_runs
  (like public.aria_action_runs including all) on commit drop;
create temporary table receipt_review_outcomes
  (like public.aria_action_receipts including all) on commit drop;

-- Exact inactive registration values from the candidate migration, targeted to
-- the TEMP copy. This tests the installed schema without activating a real tool.
insert into receipt_review_registry (
  tool_name, owner, purpose, action_class, risk_tier, allowed_agent_slugs,
  approval_rule, verification_kind, idempotency_kind, rollback_kind, active, notes
) values (
  'record_stuart_xero_customer_receipts', 'Stuart',
  'Record confirmed incoming AUD customer receipts against exact existing sales invoices',
  'commit', 'R2', array['stuart']::text[], 'exact-owner', 'provider_readback',
  'natural-key', 'manual-recovery', false,
  'Synthetic rollback verification only'
), (
  'prepare_stuart_xero_customer_receipts', 'Stuart',
  'Resolve a read-only proposed allocation from existing remittance evidence and live Xero records',
  'read', 'R0', array['stuart']::text[], 'none', 'none', 'none', 'none', false,
  'Synthetic rollback verification only'
) on conflict (tool_name) do nothing;

do $verify$
declare
  source_hash text := repeat('a', 64);
  payload_hash text := 'd4f9859d18e756ac28f5481948e6fb4816af5406ee004fba74acad670d65eb3e';
  root_id uuid;
  outcome_id uuid;
  fixture jsonb := $payload${"account_id":"00000000-0000-4000-8000-000000000003","account_last_four":"1234","allocations":[{"amount_minor":10000,"expected_due_minor":10000,"expected_paid_minor":0,"invoice_id":"00000000-0000-4000-8000-000000000006","invoice_number":"TEST-INV-1"}],"contact_id":"00000000-0000-4000-8000-000000000002","currency":"AUD","money_received_confirmed":true,"received_on":"2026-09-24","received_total_minor":10000,"remittance_reference":"TEST-REMIT-01","source_attachment_id":"00000000-0000-4000-8000-000000000005","source_email_id":"00000000-0000-4000-8000-000000000004","source_reviewed_confirmed":true,"source_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tenant_id":"00000000-0000-4000-8000-000000000001"}$payload$::jsonb;
begin
  -- This is the actual installed canonicalizer used by Workroom approvals.
  if encode(digest(convert_to(private.canonical_jsonb_text(fixture), 'UTF8'), 'sha256'), 'hex') <> payload_hash then
    raise exception 'Workroom database hash differs from receipt executor JavaScript hash';
  end if;
  if (select count(*) from receipt_review_registry where not active) <> 2 then
    raise exception 'Receipt registration must remain inactive';
  end if;

  -- Same shape and one-statement atomicity as the service's root/source/amount
  -- bulk claim. IDs are synthetic and used only in temporary schema copies.
  insert into receipt_review_runs (
    tool_name, risk_tier, target_type, target_id, request_id, correlation_id,
    idempotency_key, payload_sha256, expected_version, expected_absent,
    approval_receipt_id, authorization_kind, actor_profile_id, state, metadata
  ) select
    'record_stuart_xero_customer_receipts', 'R2', 'customer_remittance',
    'synthetic-tenant:synthetic-customer:TEST-REMIT-01', 'synthetic-request',
    'synthetic-correlation', candidate.key, payload_hash, source_hash, false,
    '00000000-0000-4000-8000-000000000020'::uuid, 'exact-approval',
    '00000000-0000-4000-8000-000000000021'::uuid, 'executing',
    jsonb_build_object('allocation_lock', candidate.is_lock, 'transport', 'synthetic-receipt-review')
  from (values
    ('customer-receipt:' || repeat('1', 64), false),
    ('receipt-source:' || repeat('2', 64), true),
    ('receipt-amount:' || repeat('3', 64), true)
  ) as candidate(key, is_lock);
  if (select count(*) from receipt_review_runs) <> 3 then raise exception 'Bulk claim did not insert exactly three rows'; end if;
  select id into strict root_id from receipt_review_runs where metadata->>'allocation_lock' = 'false';

  begin
    insert into receipt_review_runs (
      tool_name, risk_tier, target_type, target_id, request_id, correlation_id,
      idempotency_key, payload_sha256, expected_version, expected_absent,
      approval_receipt_id, authorization_kind, actor_profile_id, state, metadata
    ) select
      'record_stuart_xero_customer_receipts', 'R2', 'customer_remittance',
      'same-claim-different-request', 'changed-request', 'changed-correlation',
      candidate.key, payload_hash, source_hash, false,
      '00000000-0000-4000-8000-000000000020'::uuid, 'exact-approval',
      '00000000-0000-4000-8000-000000000021'::uuid, 'executing', '{}'::jsonb
    from (values
      ('must-not-survive-failed-bulk-insert'),
      ('receipt-source:' || repeat('2', 64))
    ) as candidate(key);
    raise exception 'Duplicate allocation was not rejected';
  exception when unique_violation then
    null;
  end;
  if (select count(*) from receipt_review_runs) <> 3 then raise exception 'A partial bulk claim survived a uniqueness conflict'; end if;
  if exists(select 1 from receipt_review_runs where idempotency_key = 'must-not-survive-failed-bulk-insert') then raise exception 'Bulk claim was not atomic'; end if;

  update receipt_review_runs
  set metadata = jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object(
    'invoice_id', '00000000-0000-4000-8000-000000000006',
    'payment_id', null, 'state', 'uncertain', 'amount_minor', 10000,
    'remaining_due_minor', null
  ))), state = 'partial', finished_at = now()
  where id = root_id;
  insert into receipt_review_outcomes (
    action_run_id, outcome, receipt_ref, result_sha256, resulting_version,
    verification_kind, verification_evidence, recorded_by
  ) values (
    root_id, 'partial', null, payload_hash, null, 'none',
    '{"state":"partial","reconciliation_performed":false,"audit_saved":true}'::jsonb,
    '00000000-0000-4000-8000-000000000021'::uuid
  ) returning id into outcome_id;
  if outcome_id is null then raise exception 'Partial outcome evidence could not be stored'; end if;

  begin
    insert into receipt_review_outcomes (
      action_run_id, outcome, result_sha256, verification_kind, recorded_by
    ) values (
      '00000000-0000-4000-8000-000000000088'::uuid, 'verified', payload_hash,
      'none', '00000000-0000-4000-8000-000000000021'::uuid
    );
    raise exception 'False verified outcome without provider evidence was accepted';
  exception when check_violation then
    null;
  end;
end;
$verify$;

select jsonb_build_object(
  'verification', 'passed',
  'inactive_registry_rows', (select count(*) from receipt_review_registry where not active),
  'atomic_claim_rows', (select count(*) from receipt_review_runs),
  'partial_outcome_rows', (select count(*) from receipt_review_outcomes),
  'workroom_payload_hash', 'matched JavaScript receipt contract',
  'production_rows_written', 0,
  'limits', 'Temporary copies do not verify production RLS, foreign keys, PostgREST permissions or a Xero provider operation'
) as receipt_release_verification;
rollback;
