insert into public.aria_tool_registry (
  tool_name, owner, purpose, action_class, risk_tier, approval_rule,
  verification_kind, idempotency_kind, rollback_kind, active, notes
)
values (
  'send_aria_email', 'Aria',
  'Send one exact owner-approved email from the RESLU Aria mailbox and return the Gmail provider receipt',
  'commit', 'R2', 'exact-owner', 'provider_readback', 'client-key', 'manual-recovery', true,
  'A current authenticated owner instruction may supply the exact approval; do not require a redundant second confirmation when recipient, subject, body and CC are already fixed.'
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
