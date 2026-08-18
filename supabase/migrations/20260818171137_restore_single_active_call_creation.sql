-- Restore the one-active-call creation contract from migration 104. Production
-- retained the older migration 093 function even though the partial unique
-- index was present, so a visually ended browser call could block the next
-- call instead of being truthfully superseded.

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

comment on function create_conversation_call_idempotent(uuid, text, uuid) is
  'Creates one retry-safe call intent. A genuinely new intent truthfully drops and records the caller''s older active call, cancels only its unfinished consults and leaves durable tasks running.';

notify pgrst, 'reload schema';
