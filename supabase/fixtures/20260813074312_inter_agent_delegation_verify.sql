-- Run after 20260813074312_inter_agent_delegation.sql. All synthetic work is
-- enclosed in this transaction and rolled back after the final PASS row.

begin;

do $verify$
declare
  v_conversation_id uuid;
  v_caller_id uuid;
  v_caller_profile_id uuid;
  v_target_id uuid;
  v_target_slug text;
  v_delegation_id text := 'verify_delegation_' || replace(gen_random_uuid()::text, '-', '_');
  v_first agent_tasks;
  v_retry agent_tasks;
  v_conflict_rejected boolean := false;
begin
  if to_regprocedure('public.delegate_conversation_agent_task(uuid,text,text,text,text,text,uuid)') is null then
    raise exception 'FAIL: inter-agent delegation function is missing';
  end if;

  select conversation.id, owner.id, owner.auth_profile_id
  into v_conversation_id, v_caller_id, v_caller_profile_id
  from conversations conversation
  join conversation_participants owner_participant
    on owner_participant.conversation_id = conversation.id
   and owner_participant.agent_id is not null
  join conversation_agents owner
    on owner.id = owner_participant.agent_id
   and owner.active
   and owner.auth_profile_id is not null
  where conversation.kind = 'direct'
  order by conversation.created_at
  limit 1;

  if v_caller_profile_id is null then
    raise exception 'FAIL: no direct chat has an authenticated active owner agent';
  end if;

  select target.id, target.slug into v_target_id, v_target_slug
  from conversation_agents target
  where target.active and target.id <> v_caller_id
  order by target.slug
  limit 1;
  if v_target_id is null then
    raise exception 'FAIL: a second active RESLU agent is required';
  end if;

  perform set_config('request.jwt.claim.sub', v_caller_profile_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;

  select * into v_first from delegate_conversation_agent_task(
    v_conversation_id,
    v_target_slug,
    v_delegation_id,
    'Verify specialist handoff',
    'Inspect this bounded synthetic handoff and return a concise result to the same canonical conversation.',
    'strong',
    null
  );
  select * into v_retry from delegate_conversation_agent_task(
    v_conversation_id,
    v_target_slug,
    v_delegation_id,
    'Verify specialist handoff',
    'Inspect this bounded synthetic handoff and return a concise result to the same canonical conversation.',
    'strong',
    null
  );

  if v_first.id is distinct from v_retry.id then
    raise exception 'FAIL: idempotency retry created duplicate work';
  end if;
  if v_first.owner_agent_id <> v_target_id
    or v_first.delegated_by_agent_id <> v_caller_id
    or v_first.requested_by <> v_caller_profile_id
    or v_first.requested_via <> 'system'
    or v_first.model_tier <> 'strong' then
    raise exception 'FAIL: delegated task attribution or execution settings are wrong';
  end if;
  if exists (
    select 1 from conversation_participants
    where conversation_id = v_conversation_id and agent_id = v_target_id
  ) then
    raise exception 'FAIL: specialist was silently added to the direct conversation';
  end if;
  begin
    perform delegate_conversation_agent_task(
      v_conversation_id,
      v_target_slug,
      v_delegation_id,
      'Different work',
      'A changed request must not reuse the same delegation id.',
      'strong',
      null
    );
  exception when others then
    if position('idempotency key conflict' in sqlerrm) > 0 then
      v_conflict_rejected := true;
    else
      raise;
    end if;
  end;
  if not v_conflict_rejected then
    raise exception 'FAIL: mismatched retry reused a delegation id';
  end if;

  -- The agent identity is intentionally not a human room member, so RLS does
  -- not let it enumerate task audit rows. Inspect as the fixture owner only.
  reset role;
  if not exists (
    select 1 from agent_task_events
    where task_id = v_first.id
      and event_type = 'queued'
      and metadata->>'owner_agent_slug' = v_target_slug
  ) then
    raise exception 'FAIL: delegation audit event is missing';
  end if;
end;
$verify$;

select 'PASS — inter-agent delegation is authenticated, bounded, idempotent and auditable; transaction will now roll back' as result;

rollback;
