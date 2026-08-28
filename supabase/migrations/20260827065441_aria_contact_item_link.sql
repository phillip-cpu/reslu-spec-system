insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, approval_rule,
  verification_kind, idempotency_kind, rollback_kind, active, notes
)
values (
  'ensure_supplier_contact_and_link_item', 'Spec',
  'Create or reuse one exact verified supplier contact and link it to one existing specification item with readback',
  'prepare', 'R1', 'none', 'spec_readback', 'natural-key', 'restore-version', true,
  'R1 internal work: proceed when requested. Exact email is the contact natural key; never replace a different existing item link and never create a task instead of completing the link.'
)
on conflict (tool_name) do update set
  owner = excluded.owner,
  purpose = excluded.purpose,
  action_class = excluded.action_class,
  risk_tier = excluded.risk_tier,
  approval_rule = excluded.approval_rule,
  verification_kind = excluded.verification_kind,
  idempotency_kind = excluded.idempotency_kind,
  rollback_kind = excluded.rollback_kind,
  active = excluded.active,
  notes = excluded.notes,
  updated_at = now();
