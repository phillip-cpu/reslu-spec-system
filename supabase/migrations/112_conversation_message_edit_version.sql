-- Repair the optimistic message-edit version installed by migration 105.
-- PostgreSQL `now()` is transaction-stable, so an insert and edit performed in
-- one transaction can otherwise receive the same version. Every real edit now
-- advances the canonical timestamp by at least one microsecond.

create or replace function edit_conversation_message(
  p_conversation_id uuid,
  p_message_id uuid,
  p_body text,
  p_expected_version timestamptz
)
returns conversation_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row conversation_messages;
  normalized_body text;
begin
  if auth.uid() is null or p_conversation_id is null or p_message_id is null then
    raise exception 'unauthorized';
  end if;
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  normalized_body := btrim(coalesce(p_body, ''));
  if char_length(normalized_body) < 1 or char_length(normalized_body) > 20000 then
    raise exception 'message body is invalid';
  end if;
  if p_expected_version is null then
    raise exception 'message version is required';
  end if;

  select * into message_row
  from conversation_messages message
  where message.id = p_message_id
    and message.conversation_id = p_conversation_id
    and message.author_profile_id = auth.uid()
    and message.author_agent_id is null
    and message.kind = 'text'
  for update;

  if not found then
    raise exception 'message not found';
  end if;
  if message_row.deleted_at is not null then
    raise exception 'deleted messages cannot be edited';
  end if;
  if now() > message_row.created_at + interval '15 minutes' then
    raise exception 'the 15 minute edit window has ended';
  end if;
  if coalesce(message_row.edited_at, message_row.created_at) is distinct from p_expected_version then
    raise exception 'message changed on another device';
  end if;
  if normalized_body = message_row.body then
    return message_row;
  end if;

  update conversation_messages message
  set
    body = normalized_body,
    edited_at = greatest(
      clock_timestamp(),
      coalesce(message_row.edited_at, message_row.created_at) + interval '1 microsecond'
    )
  where message.id = message_row.id
  returning * into message_row;

  return message_row;
end;
$$;

revoke all on function edit_conversation_message(uuid, uuid, text, timestamptz)
  from public, anon;
grant execute on function edit_conversation_message(uuid, uuid, text, timestamptz)
  to authenticated;

comment on function edit_conversation_message(uuid, uuid, text, timestamptz) is
  'Edits an owned human text message within 15 minutes using a strictly advancing optimistic version; it never re-enqueues an agent.';

notify pgrst, 'reload schema';
