-- Per-participant conversation controls. Archive and pin must never mutate the
-- shared conversation row because each RESLU team member owns their own inbox.

alter table conversation_participants
  add column if not exists archived_at timestamptz,
  add column if not exists pinned_at timestamptz;

create index if not exists conversation_participant_inbox_order_idx
  on conversation_participants(profile_id, archived_at, pinned_at desc)
  where profile_id is not null;

drop function if exists get_conversation_inbox();
create function get_conversation_inbox()
returns table (
  conversation_id uuid,
  last_read_at timestamptz,
  notifications_muted boolean,
  archived_at timestamptz,
  pinned_at timestamptz,
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
    participant.archived_at,
    participant.pinned_at,
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
    participant.archived_at,
    participant.pinned_at,
    participant.last_read_message_id;
$$;

revoke all on function get_conversation_inbox() from public, anon;
grant execute on function get_conversation_inbox() to authenticated;

create or replace function update_conversation_preferences(
  p_conversation_id uuid,
  p_notifications_muted boolean default null,
  p_archived boolean default null,
  p_pinned boolean default null
)
returns table (
  notifications_muted boolean,
  archived_at timestamptz,
  pinned_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  resulting_notifications_muted boolean;
  resulting_archived_at timestamptz;
  resulting_pinned_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'unauthorized';
  end if;
  if p_notifications_muted is null and p_archived is null and p_pinned is null then
    raise exception 'no preference change requested';
  end if;
  if p_archived is true and p_pinned is true then
    raise exception 'a conversation cannot be archived and pinned at the same time';
  end if;

  update conversation_participants participant
  set
    notifications_muted = coalesce(p_notifications_muted, participant.notifications_muted),
    archived_at = case
      when p_archived is true then now()
      when p_archived is false then null
      when p_pinned is true then null
      else participant.archived_at
    end,
    pinned_at = case
      when p_pinned is true then now()
      when p_pinned is false then null
      when p_archived is true then null
      else participant.pinned_at
    end
  where participant.conversation_id = p_conversation_id
    and participant.profile_id = auth.uid()
  returning
    participant.notifications_muted,
    participant.archived_at,
    participant.pinned_at
  into
    resulting_notifications_muted,
    resulting_archived_at,
    resulting_pinned_at;

  if not found then
    raise exception 'conversation not found';
  end if;

  return query select
    resulting_notifications_muted,
    resulting_archived_at,
    resulting_pinned_at;
end;
$$;

revoke all on function update_conversation_preferences(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function update_conversation_preferences(uuid, boolean, boolean, boolean) to authenticated;

comment on column conversation_participants.archived_at is
  'Per-profile archive state. Never use conversations.archived_at for an individual inbox action.';
comment on column conversation_participants.pinned_at is
  'Per-profile pin state used to order that profile''s active conversation inbox.';
comment on function update_conversation_preferences(uuid, boolean, boolean, boolean) is
  'Updates only auth.uid()''s mute/archive/pin state. Pinning unarchives and archiving unpins.';

notify pgrst, 'reload schema';
