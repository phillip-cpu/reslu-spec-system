-- Repair migration 108 with a database-level last-human-admin invariant.
-- The RPC already performs an early check; this trigger prevents any current
-- or future write path from committing an administrator-less live group.

create or replace function enforce_conversation_group_human_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_conversation_id uuid;
  affected_conversation_ids uuid[] := case
    when tg_op = 'UPDATE' then array[old.conversation_id, new.conversation_id]
    else array[old.conversation_id]
  end;
begin
  foreach affected_conversation_id in array affected_conversation_ids loop
    if exists (
      select 1 from conversations conversation
      where conversation.id = affected_conversation_id
        and conversation.kind = 'group'
    ) and not exists (
      select 1 from conversation_participants participant
      where participant.conversation_id = affected_conversation_id
        and participant.profile_id is not null
        and participant.participant_role = 'admin'
    ) then
      raise exception 'a group must keep at least one admin';
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_require_group_human_admin on conversation_participants;
create trigger trg_require_group_human_admin
  after update of participant_role, profile_id, conversation_id or delete
  on conversation_participants
  for each row execute function enforce_conversation_group_human_admin();

revoke all on function enforce_conversation_group_human_admin()
  from public, anon, authenticated;

comment on function enforce_conversation_group_human_admin() is
  'Rejects any participant mutation that would leave a live group without a human admin.';

notify pgrst, 'reload schema';
