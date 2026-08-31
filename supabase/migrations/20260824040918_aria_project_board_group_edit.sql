insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, approval_rule,
  verification_kind, idempotency_kind, rollback_kind, active
)
values (
  'update_board_group', 'Spec',
  'Rename or reorder an existing project work-board phase group with version checking and readback',
  'prepare', 'R1', 'none', 'spec_readback', 'client-key', 'restore-version', true
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
  updated_at = now();
