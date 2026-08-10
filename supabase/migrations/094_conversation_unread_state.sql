-- Canonical per-participant unread state for RESLU conversations.
-- Counts live in Postgres so iPhone, desktop and future native clients agree.

alter table conversation_participants
  add column if not exists last_read_message_id uuid;

-- Older deployments stored only a timestamp. Anchor every existing cursor to
-- the greatest canonical id at that timestamp so equal-timestamp messages do
-- not become ambiguously read during the composite-cursor rollout.
update conversation_participants participant
set last_read_message_id = (
  select message.id
  from conversation_messages message
  where message.conversation_id = participant.conversation_id
    and message.deleted_at is null
    and message.created_at <= participant.last_read_at
  order by message.created_at desc, message.id desc
  limit 1
)
where participant.last_read_at is not null
  and participant.last_read_message_id is null;

alter table notifications
  add column if not exists source_message_id uuid
  references conversation_messages(id) on delete cascade;

create or replace function get_conversation_inbox()
returns table (
  conversation_id uuid,
  last_read_at timestamptz,
  notifications_muted boolean,
  unread_count bigint,
  last_message_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    participant.conversation_id,
    participant.last_read_at,
    participant.notifications_muted,
    count(message.id)::bigint as unread_count,
    (
      select newest.id
      from conversation_messages newest
      where newest.conversation_id = participant.conversation_id
        and newest.deleted_at is null
      order by newest.created_at desc, newest.id desc
      limit 1
    ) as last_message_id
  from conversation_participants participant
  left join conversation_messages message
    on message.conversation_id = participant.conversation_id
   and message.deleted_at is null
   and (
     message.created_at > greatest(
       coalesce(participant.last_read_at, participant.joined_at),
       participant.joined_at
     )
     or (
       participant.last_read_at is not null
       and participant.last_read_message_id is not null
       and participant.last_read_at >= participant.joined_at
       and message.created_at = participant.last_read_at
       and message.id > participant.last_read_message_id
     )
   )
   and message.author_profile_id is distinct from auth.uid()
  where participant.profile_id = auth.uid()
  group by
    participant.conversation_id,
    participant.last_read_at,
    participant.notifications_muted,
    participant.last_read_message_id;
$$;

revoke all on function get_conversation_inbox() from public, anon;
grant execute on function get_conversation_inbox() to authenticated;

create or replace function mark_conversation_read(
  p_conversation_id uuid,
  p_through_message_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  through_created_at timestamptz;
  resulting_last_read_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'unauthorized';
  end if;

  select message.created_at
  into through_created_at
  from conversation_messages message
  join conversation_participants participant
    on participant.conversation_id = message.conversation_id
   and participant.profile_id = auth.uid()
  where message.id = p_through_message_id
    and message.conversation_id = p_conversation_id
    and message.deleted_at is null;

  if through_created_at is null then
    raise exception 'conversation message not found';
  end if;

  update conversation_participants participant
  set
    last_read_at = case
      when participant.last_read_at is null
        or through_created_at > participant.last_read_at
        or (
          through_created_at = participant.last_read_at
          and (
            participant.last_read_message_id is null
            or p_through_message_id > participant.last_read_message_id
          )
        )
      then through_created_at
      else participant.last_read_at
    end,
    last_read_message_id = case
      when participant.last_read_at is null
        or through_created_at > participant.last_read_at
        or (
          through_created_at = participant.last_read_at
          and (
            participant.last_read_message_id is null
            or p_through_message_id > participant.last_read_message_id
          )
        )
      then p_through_message_id
      else participant.last_read_message_id
    end
  where participant.conversation_id = p_conversation_id
    and participant.profile_id = auth.uid()
  returning participant.last_read_at into resulting_last_read_at;

  if resulting_last_read_at is null then
    raise exception 'conversation not found';
  end if;

  update notifications notification
  set read_at = coalesce(notification.read_at, now())
  where notification.user_id = auth.uid()
    and notification.kind = 'conversation_message:' || p_conversation_id::text
    and exists (
      select 1
      from conversation_messages source_message
      where source_message.id = notification.source_message_id
        and source_message.conversation_id = p_conversation_id
        and (
          source_message.created_at < through_created_at
          or (
            source_message.created_at = through_created_at
            and source_message.id <= p_through_message_id
          )
        )
    )
    and notification.read_at is null;

  return resulting_last_read_at;
end;
$$;

revoke all on function mark_conversation_read(uuid, uuid) from public, anon;
grant execute on function mark_conversation_read(uuid, uuid) to authenticated;

comment on function get_conversation_inbox() is
  'Returns the signed-in profile''s canonical unread count, mute state and exact newest message id for each RESLU conversation.';
comment on function mark_conversation_read(uuid, uuid) is
  'Advances only the signed-in participant''s composite message timestamp/id cursor through a real message in the same conversation. It never marks a future or unseen client timestamp.';
comment on column conversation_participants.last_read_message_id is
  'UUID tie-breaker for last_read_at so messages created in the same timestamp remain ordered and cannot be lost from unread state.';
comment on column notifications.source_message_id is
  'Exact canonical message represented by a private conversation notification; used to advance notification state through the same timestamp/id cursor as chat unread state.';

notify pgrst, 'reload schema';
