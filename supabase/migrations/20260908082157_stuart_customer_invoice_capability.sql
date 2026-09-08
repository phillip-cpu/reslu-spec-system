-- Version matches the production migration receipt (20260908082157).
-- No new exposed tables or broader grants. Reuse the existing R2 exact-owner
-- action ledger for invoice-scoped idempotency and provider readback.
insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, approval_rule,
  verification_kind, idempotency_kind, rollback_kind, active, allowed_agent_slugs
) values
  ('get_stuart_customer_invoice_source','Finance','Read one Stuart-shared PDF identity without exposing its bytes','read','R0','none','none','none','none',true,array['stuart']::text[]),
  ('create_stuart_xero_draft_customer_invoice','Finance','Create an exact-approved source-backed DRAFT ACCREC customer invoice only','commit','R2','exact-owner','provider_readback','provider-key','manual-recovery',true,array['stuart']::text[])
on conflict (tool_name) do nothing;
