-- Recover orphaned browser calls and enforce one canonical active call per
-- person. Starting another call ends only the old conversational turn; durable
-- background tasks keep their independent lifecycle.

with ranked_active as (
  select
    call.id,
    call.started_at,
    row_number() over (
      partition by call.started_by
      order by call.started_at desc, call.id desc
    ) as active_rank
  from conversation_calls call
  where call.status = 'active'
), recovery_targets as (
  select
    ranked.id,
    case
      when ranked.active_rank > 1 then 'duplicate_active_recovered'
      else 'stale_active_recovered'
    end as recovery_reason
  from ranked_active ranked
  where ranked.active_rank > 1
     or ranked.started_at < now() - interval '4 hours'
)
update conversation_calls call
set
  status = 'dropped',
  ended_at = coalesce(call.ended_at, now()),
  metadata = coalesce(call.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'active_call_recovery_reason', target.recovery_reason,
      'active_call_recovered_at', now()
    )
from recovery_targets target
where call.id = target.id;

update agent_conversation_jobs job
set status = 'cancelled', completed_at = coalesce(job.completed_at, now())
where job.status in ('pending', 'processing')
  and exists (
    select 1
    from conversation_messages message
    join conversation_calls call
      on call.id::text = message.metadata->>'realtime_call_id'
    where message.id = job.triggering_message_id
      and call.status = 'dropped'
      and call.metadata ? 'active_call_recovery_reason'
  );

insert into conversation_messages(
  conversation_id,
  author_profile_id,
  kind,
  body,
  metadata
)
select
  call.conversation_id,
  call.started_by,
  'call_record',
  'Call recovered as dropped because it was left active without a live session.',
  jsonb_build_object(
    'call_id', call.id,
    'presentation', call.presentation,
    'status', 'dropped',
    'reason', call.metadata->>'active_call_recovery_reason',
    'exact_end_time_available', false
  )
from conversation_calls call
where call.status = 'dropped'
  and call.metadata ? 'active_call_recovery_reason'
  and not exists (
    select 1
    from conversation_messages message
    where message.conversation_id = call.conversation_id
      and message.kind = 'call_record'
      and message.metadata->>'call_id' = call.id::text
  );

create unique index if not exists conversation_calls_one_active_per_starter
  on conversation_calls(started_by)
  where status = 'active';

create or replace function create_conversation_call_idempotent(
  p_conversation_id uuid,
  p_presentation text,
  p_client_call_id uuid
)
returns conversation_calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_row conversation_calls;
  superseded_call conversation_calls;
  duration_seconds integer;
begin
  if p_conversation_id is null
     or auth.uid() is null
     or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if p_client_call_id is null then
    raise exception 'client call id is required';
  end if;
  if p_presentation is null
     or p_presentation not in ('office', 'driving', 'meeting') then
    raise exception 'call presentation is invalid';
  end if;

  -- Different device intents for the same person must serialize as well as a
  -- retry of the same intent. This lock plus the partial index makes the
  -- one-active-call invariant authoritative in the database.
  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':active-conversation-call', 0)
  );

  select * into call_row
  from conversation_calls call
  where call.started_by = auth.uid()
    and call.client_call_id = p_client_call_id;

  if found then
    if call_row.conversation_id <> p_conversation_id
       or call_row.presentation <> p_presentation then
      raise exception 'client call id was already used for a different call';
    end if;
    return call_row;
  end if;

  for superseded_call in
    update conversation_calls call
    set
      status = 'dropped',
      ended_at = now(),
      metadata = coalesce(call.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'active_call_recovery_reason', 'superseded_by_new_call',
          'active_call_recovered_at', now()
        )
    where call.started_by = auth.uid()
      and call.status = 'active'
    returning call.*
  loop
    -- A superseded live conversational turn must not publish late output.
    -- Durable agent_tasks are deliberately not part of this cancellation.
    update agent_conversation_jobs job
    set status = 'cancelled', completed_at = coalesce(job.completed_at, now())
    where job.conversation_id = superseded_call.conversation_id
      and job.status in ('pending', 'processing')
      and exists (
        select 1
        from conversation_messages message
        where message.id = job.triggering_message_id
          and message.conversation_id = superseded_call.conversation_id
          and message.author_profile_id = auth.uid()
          and message.metadata->>'realtime_call_id' = superseded_call.id::text
      );

    duration_seconds := greatest(
      0,
      round(extract(epoch from (superseded_call.ended_at - superseded_call.started_at)))::integer
    );
    if not exists (
      select 1
      from conversation_messages message
      where message.conversation_id = superseded_call.conversation_id
        and message.kind = 'call_record'
        and message.metadata->>'call_id' = superseded_call.id::text
    ) then
      insert into conversation_messages(
        conversation_id,
        author_profile_id,
        kind,
        body,
        metadata
      ) values (
        superseded_call.conversation_id,
        auth.uid(),
        'call_record',
        'Call dropped when another call started.',
        jsonb_build_object(
          'call_id', superseded_call.id,
          'duration_seconds', duration_seconds,
          'presentation', superseded_call.presentation,
          'status', 'dropped',
          'reason', 'superseded_by_new_call'
        )
      );
    end if;
  end loop;

  insert into conversation_calls(
    conversation_id,
    started_by,
    presentation,
    client_call_id
  ) values (
    p_conversation_id,
    auth.uid(),
    p_presentation,
    p_client_call_id
  )
  returning * into call_row;

  return call_row;
end;
$$;

revoke all on function create_conversation_call_idempotent(uuid, text, uuid) from public, anon;
grant execute on function create_conversation_call_idempotent(uuid, text, uuid) to authenticated;

comment on index conversation_calls_one_active_per_starter is
  'A profile may own only one canonical active RESLU call across devices and conversations.';
comment on function create_conversation_call_idempotent(uuid, text, uuid) is
  'Creates one retry-safe call intent. A genuinely new intent truthfully drops and records the caller''s older active call, cancels only its unfinished consults and leaves durable tasks running.';

notify pgrst, 'reload schema';
