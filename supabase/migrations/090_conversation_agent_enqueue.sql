-- Queue agent work in the same database transaction as the human message.
-- This removes the fragile gap where a visible message could be committed
-- while the following client-side agent job insert failed silently.

create or replace function enqueue_conversation_agents_for_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  participant_count integer;
  agent_count integer;
begin
  if new.author_profile_id is null or new.kind <> 'text' then
    return new;
  end if;

  select count(*), count(*) filter (where agent_id is not null)
  into participant_count, agent_count
  from conversation_participants
  where conversation_id = new.conversation_id;

  insert into agent_conversation_jobs (
    conversation_id,
    triggering_message_id,
    agent_id
  )
  select
    new.conversation_id,
    new.id,
    cp.agent_id
  from conversation_participants cp
  join conversation_agents agent on agent.id = cp.agent_id and agent.active
  where cp.conversation_id = new.conversation_id
    and cp.agent_id is not null
    and (
      (participant_count = 2 and agent_count = 1)
      or agent.slug in (
        select jsonb_array_elements_text(
          coalesce(new.metadata->'target_agent_slugs', '[]'::jsonb)
        )
      )
    )
  on conflict (triggering_message_id, agent_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_conversation_message_agent_enqueue on conversation_messages;
create trigger trg_conversation_message_agent_enqueue
  after insert on conversation_messages
  for each row execute function enqueue_conversation_agents_for_message();

comment on function enqueue_conversation_agents_for_message() is
  'Atomically queues the sole agent in a direct chat, or explicitly targeted agents in a group, whenever a human message is inserted.';

notify pgrst, 'reload schema';
