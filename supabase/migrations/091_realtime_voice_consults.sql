-- Idempotent OpenAI Realtime consults and precise barge-in cancellation.
-- Canonical human and agent messages remain in conversation_messages;
-- agent_conversation_jobs remains the outbound OpenClaw transport.

create unique index if not exists conversation_messages_realtime_tool_call_unique
  on conversation_messages(conversation_id, (metadata->>'realtime_tool_call_id'))
  where deleted_at is null and metadata ? 'realtime_tool_call_id';

create or replace function cancel_realtime_conversation_job(
  p_conversation_id uuid,
  p_tool_call_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  update agent_conversation_jobs job
  set status = 'cancelled', completed_at = now()
  where job.conversation_id = p_conversation_id
    and job.status in ('pending', 'processing')
    and exists (
      select 1
      from conversation_messages message
      where message.id = job.triggering_message_id
        and message.conversation_id = p_conversation_id
        and message.metadata->>'realtime_tool_call_id' = p_tool_call_id
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function cancel_realtime_conversation_job(uuid, text) from public, anon;
grant execute on function cancel_realtime_conversation_job(uuid, text) to authenticated;

comment on function cancel_realtime_conversation_job(uuid, text) is
  'Cancels only the unfinished OpenClaw consult associated with one Realtime function call. It suppresses late speech but does not reverse completed business side effects.';

notify pgrst, 'reload schema';
