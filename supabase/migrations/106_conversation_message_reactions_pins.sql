-- Shared message reactions and pins over the canonical conversation timeline.
-- One person owns one current reaction per message; a conversation may expose
-- at most five pinned messages so the mobile header remains useful.

create table if not exists conversation_message_reactions (
  message_id       uuid not null references conversation_messages(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  profile_id       uuid not null references profiles(id) on delete cascade,
  reaction         text not null check (reaction in ('👍','❤️','😂','😮','😢','🙏')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (message_id, profile_id)
);

create index if not exists conversation_message_reactions_conversation_idx
  on conversation_message_reactions(conversation_id, message_id);

create table if not exists conversation_message_pins (
  message_id       uuid primary key references conversation_messages(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  pinned_by        uuid not null references profiles(id) on delete cascade,
  pinned_at        timestamptz not null default now()
);

create index if not exists conversation_message_pins_conversation_idx
  on conversation_message_pins(conversation_id, pinned_at desc);

alter table conversation_message_reactions enable row level security;
alter table conversation_message_pins enable row level security;

drop policy if exists "members_read_message_reactions" on conversation_message_reactions;
create policy "members_read_message_reactions"
  on conversation_message_reactions
  for select to authenticated
  using (is_conversation_member(conversation_id));

drop policy if exists "members_read_message_pins" on conversation_message_pins;
create policy "members_read_message_pins"
  on conversation_message_pins
  for select to authenticated
  using (is_conversation_member(conversation_id));

create or replace function toggle_conversation_message_reaction(
  p_conversation_id uuid,
  p_message_id uuid,
  p_reaction text
)
returns table (reaction text, active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_reaction text;
begin
  if auth.uid() is null or p_conversation_id is null or p_message_id is null then
    raise exception 'unauthorized';
  end if;
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if p_reaction is null or p_reaction not in ('👍','❤️','😂','😮','😢','🙏') then
    raise exception 'reaction is invalid';
  end if;
  perform 1
  from conversation_messages message
  where message.id = p_message_id
    and message.conversation_id = p_conversation_id
    and message.deleted_at is null
  for update;
  if not found then
    raise exception 'message not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':message-reaction:' || p_message_id::text, 0)
  );

  select item.reaction into existing_reaction
  from conversation_message_reactions item
  where item.message_id = p_message_id
    and item.profile_id = auth.uid();

  if existing_reaction = p_reaction then
    delete from conversation_message_reactions item
    where item.message_id = p_message_id
      and item.profile_id = auth.uid();
    return query select p_reaction, false;
    return;
  end if;

  insert into conversation_message_reactions(
    message_id,
    conversation_id,
    profile_id,
    reaction
  ) values (
    p_message_id,
    p_conversation_id,
    auth.uid(),
    p_reaction
  )
  on conflict (message_id, profile_id) do update
  set reaction = excluded.reaction, updated_at = now();

  return query select p_reaction, true;
end;
$$;

create or replace function set_conversation_message_pinned(
  p_conversation_id uuid,
  p_message_id uuid,
  p_pinned boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  pinned_count integer;
begin
  if auth.uid() is null or p_conversation_id is null or p_message_id is null or p_pinned is null then
    raise exception 'unauthorized';
  end if;
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':conversation-message-pins', 0)
  );

  if not p_pinned then
    delete from conversation_message_pins item
    where item.message_id = p_message_id
      and item.conversation_id = p_conversation_id;
    return false;
  end if;

  perform 1
  from conversation_messages message
  where message.id = p_message_id
    and message.conversation_id = p_conversation_id
    and message.deleted_at is null
  for update;
  if not found then
    raise exception 'message not found';
  end if;
  if exists (
    select 1 from conversation_message_pins item
    where item.message_id = p_message_id
      and item.conversation_id = p_conversation_id
  ) then
    return true;
  end if;

  select count(*) into pinned_count
  from conversation_message_pins item
  where item.conversation_id = p_conversation_id;
  if pinned_count >= 5 then
    raise exception 'a conversation can pin no more than five messages';
  end if;

  insert into conversation_message_pins(
    message_id,
    conversation_id,
    pinned_by
  ) values (
    p_message_id,
    p_conversation_id,
    auth.uid()
  );
  return true;
end;
$$;

create or replace function clear_conversation_message_engagement_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    delete from conversation_message_reactions item where item.message_id = new.id;
    delete from conversation_message_pins item where item.message_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clear_conversation_message_engagement on conversation_messages;
create trigger trg_clear_conversation_message_engagement
  after update of deleted_at on conversation_messages
  for each row execute function clear_conversation_message_engagement_on_delete();

revoke all on function toggle_conversation_message_reaction(uuid, uuid, text) from public, anon;
revoke all on function set_conversation_message_pinned(uuid, uuid, boolean) from public, anon;
revoke all on function clear_conversation_message_engagement_on_delete() from public, anon, authenticated;
grant execute on function toggle_conversation_message_reaction(uuid, uuid, text) to authenticated;
grant execute on function set_conversation_message_pinned(uuid, uuid, boolean) to authenticated;

comment on table conversation_message_reactions is
  'One current quick reaction per human member and canonical message.';
comment on table conversation_message_pins is
  'Up to five shared pinned-message pointers per canonical conversation.';
comment on function toggle_conversation_message_reaction(uuid, uuid, text) is
  'Adds, changes or removes the authenticated member''s one reaction without modifying the message.';
comment on function set_conversation_message_pinned(uuid, uuid, boolean) is
  'Pins or unpins one live canonical message for every conversation member.';

notify pgrst, 'reload schema';
