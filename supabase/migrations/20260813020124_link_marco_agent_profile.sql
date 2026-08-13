-- Link Marco's least-privilege Auth profile to the existing conversation
-- agent without granting admin or broader operational access.

create or replace function public.link_marco_agent_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(new.email) = 'marco@reslu.com.au' then
    update public.conversation_agents
    set auth_profile_id = new.id, updated_at = now()
    where slug = 'marco';
  end if;
  return new;
end;
$$;

revoke all on function public.link_marco_agent_profile() from public;
grant execute on function public.link_marco_agent_profile() to service_role;

drop trigger if exists trg_link_marco_agent_profile on public.profiles;
create trigger trg_link_marco_agent_profile
  after insert or update of email on public.profiles
  for each row execute function public.link_marco_agent_profile();

update public.conversation_agents agent
set auth_profile_id = profile.id, updated_at = now()
from public.profiles profile
where agent.slug = 'marco'
  and lower(profile.email) = 'marco@reslu.com.au';
