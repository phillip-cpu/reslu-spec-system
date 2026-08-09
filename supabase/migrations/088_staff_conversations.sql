-- RESLU staff conversations: humans and existing agents share one canonical thread.
-- Voice is a modality over these records, never a second conversation store.

create table if not exists conversation_agents (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug in ('aria','marco')),
  display_name    text not null,
  role_label      text not null,
  avatar_url      text,
  voice_name      text,
  auth_profile_id uuid unique references profiles(id) on delete set null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

insert into conversation_agents (slug, display_name, role_label, voice_name, auth_profile_id)
values
  ('aria', 'Aria', 'Studio assistant', 'Samantha', (select id from profiles where lower(email) = 'aria@reslu.com.au' limit 1)),
  ('marco', 'Marco', 'Commercial strategist', 'Daniel', null)
on conflict (slug) do update set
  display_name = excluded.display_name,
  role_label = excluded.role_label,
  auth_profile_id = coalesce(conversation_agents.auth_profile_id, excluded.auth_profile_id),
  updated_at = now();

create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'direct' check (kind in ('direct','group')),
  title       text,
  created_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists conversation_participants (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  profile_id          uuid references profiles(id) on delete cascade,
  agent_id            uuid references conversation_agents(id) on delete cascade,
  joined_at           timestamptz not null default now(),
  last_read_at        timestamptz,
  notifications_muted boolean not null default false,
  check (num_nonnulls(profile_id, agent_id) = 1)
);

create unique index if not exists conversation_participant_profile_unique
  on conversation_participants(conversation_id, profile_id) where profile_id is not null;
create unique index if not exists conversation_participant_agent_unique
  on conversation_participants(conversation_id, agent_id) where agent_id is not null;
create index if not exists conversation_participant_profile_lookup
  on conversation_participants(profile_id, conversation_id) where profile_id is not null;

create table if not exists conversation_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references conversations(id) on delete cascade,
  author_profile_id uuid references profiles(id) on delete set null,
  author_agent_id   uuid references conversation_agents(id) on delete set null,
  kind              text not null default 'text' check (kind in ('text','call_record','meeting_record','system')),
  body              text not null check (char_length(body) between 1 and 20000),
  metadata          jsonb not null default '{}'::jsonb,
  reply_to_id       uuid references conversation_messages(id) on delete set null,
  created_at        timestamptz not null default now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  check (num_nonnulls(author_profile_id, author_agent_id) = 1)
);

create index if not exists conversation_messages_thread_idx
  on conversation_messages(conversation_id, created_at) where deleted_at is null;

create table if not exists agent_conversation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  triggering_message_id uuid not null references conversation_messages(id) on delete cascade,
  agent_id            uuid not null references conversation_agents(id) on delete cascade,
  status              text not null default 'pending' check (status in ('pending','processing','done','failed','cancelled')),
  claimed_at          timestamptz,
  completed_at        timestamptz,
  error               text,
  created_at          timestamptz not null default now(),
  unique (triggering_message_id, agent_id)
);

create index if not exists agent_conversation_jobs_pending_idx
  on agent_conversation_jobs(status, created_at);

create table if not exists conversation_calls (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  started_by       uuid not null references profiles(id),
  status           text not null default 'active' check (status in ('active','ended','dropped','cancelled')),
  presentation     text not null default 'office' check (presentation in ('office','driving','meeting')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  summary          text,
  decisions        jsonb not null default '[]'::jsonb,
  actions          jsonb not null default '[]'::jsonb,
  open_questions   jsonb not null default '[]'::jsonb,
  metadata         jsonb not null default '{}'::jsonb
);

create or replace function is_conversation_member(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversation_participants
    where conversation_id = p_conversation_id and profile_id = auth.uid()
  );
$$;

create or replace function claim_agent_conversation_job(p_agent_slug text)
returns setof agent_conversation_jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  update agent_conversation_jobs j
  set status = 'processing', claimed_at = now()
  where j.id = (
    select candidate.id
    from agent_conversation_jobs candidate
    join conversation_agents a on a.id = candidate.agent_id
    where a.slug = p_agent_slug
      and (candidate.status = 'pending' or (candidate.status = 'processing' and candidate.claimed_at < now() - interval '15 minutes'))
    order by candidate.created_at
    for update skip locked
    limit 1
  )
  returning j.*;
end;
$$;

revoke all on function claim_agent_conversation_job(text) from public, anon, authenticated;
grant execute on function claim_agent_conversation_job(text) to service_role;

create or replace function cancel_agent_conversation_jobs(p_conversation_id uuid, p_agent_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  affected integer;
begin
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  update agent_conversation_jobs
  set status = 'cancelled', completed_at = now()
  where conversation_id = p_conversation_id
    and agent_id = any(p_agent_ids)
    and status in ('pending','processing');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function cancel_agent_conversation_jobs(uuid, uuid[]) from public, anon;
grant execute on function cancel_agent_conversation_jobs(uuid, uuid[]) to authenticated;

alter table conversation_agents enable row level security;
alter table conversations enable row level security;
alter table conversation_participants enable row level security;
alter table conversation_messages enable row level security;
alter table agent_conversation_jobs enable row level security;
alter table conversation_calls enable row level security;

create policy "team_read_agents" on conversation_agents for select to authenticated using (active);
create policy "members_read_conversations" on conversations for select to authenticated using (is_conversation_member(id));
create policy "members_update_conversations" on conversations for update to authenticated using (is_conversation_member(id));
create policy "team_create_conversations" on conversations for insert to authenticated with check (created_by = auth.uid());
create policy "creator_deletes_empty_conversation" on conversations for delete to authenticated using (
  created_by = auth.uid() and not exists (
    select 1 from conversation_participants cp where cp.conversation_id = conversations.id
  )
);
create policy "members_read_participants" on conversation_participants for select to authenticated using (is_conversation_member(conversation_id));
create policy "creators_add_participants" on conversation_participants for insert to authenticated with check (
  exists (select 1 from conversations c where c.id = conversation_id and c.created_by = auth.uid())
);
create policy "members_read_messages" on conversation_messages for select to authenticated using (is_conversation_member(conversation_id));
create policy "members_send_messages" on conversation_messages for insert to authenticated with check (
  is_conversation_member(conversation_id) and author_profile_id = auth.uid() and author_agent_id is null
);
create policy "members_read_agent_jobs" on agent_conversation_jobs for select to authenticated using (is_conversation_member(conversation_id));
create policy "members_create_agent_jobs" on agent_conversation_jobs for insert to authenticated with check (is_conversation_member(conversation_id));
create policy "members_read_calls" on conversation_calls for select to authenticated using (is_conversation_member(conversation_id));
create policy "members_create_calls" on conversation_calls for insert to authenticated with check (
  is_conversation_member(conversation_id) and started_by = auth.uid()
);
create policy "call_starter_updates" on conversation_calls for update to authenticated using (started_by = auth.uid());

create trigger trg_conversation_agents_updated_at before update on conversation_agents
  for each row execute function set_updated_at();
create trigger trg_conversations_updated_at before update on conversations
  for each row execute function set_updated_at();

comment on table conversations is 'Canonical RESLU staff conversation. Humans and agents share the same participant model; voice and meetings append to this thread.';
comment on table agent_conversation_jobs is 'Low-latency transport inbox for existing Aria/Marco runtimes. The Mac mini bridge claims work and writes the canonical agent reply back to conversation_messages.';

notify pgrst, 'reload schema';
