-- Register the narrowly scoped candidate without enabling it. No roles,
-- grants, OAuth scopes or approval rules for other tools are changed.
insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, allowed_agent_slugs,
  approval_rule, verification_kind, idempotency_kind, rollback_kind, active, notes
) values (
  'record_stuart_xero_customer_receipts', 'Stuart',
  'Record confirmed incoming AUD customer receipts against exact existing sales invoices',
  'commit', 'R2', array['stuart']::text[], 'exact-owner', 'provider_readback',
  'natural-key', 'manual-recovery', false,
  'Disabled pending reviewed activation, configured human owner and Xero payment consent. No outgoing payments or bank reconciliation. Uncertain outcomes require read-only recovery.'
), (
  'prepare_stuart_xero_customer_receipts', 'Stuart',
  'Resolve a read-only proposed allocation from existing remittance evidence and live Xero records',
  'read', 'R0', array['stuart']::text[], 'none', 'none',
  'none', 'none', false,
  'Disabled pending reviewed activation. Proposals contain no approval and never confirm received funds on behalf of the owner.'
) on conflict (tool_name) do nothing;
