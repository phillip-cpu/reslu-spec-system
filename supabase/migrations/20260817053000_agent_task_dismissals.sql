-- Agent Work is an inbox, not permanent page furniture. Each conversation
-- member can clear terminal work from their own view without deleting the
-- durable task, its audit events, or its artifacts for anyone else.

create table if not exists public.agent_task_dismissals (
  task_id       uuid not null references public.agent_tasks(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  dismissed_at  timestamptz not null default now(),
  primary key (task_id, profile_id)
);

alter table public.agent_task_dismissals enable row level security;

revoke all on table public.agent_task_dismissals from public, anon;
grant select, insert on table public.agent_task_dismissals to authenticated;
grant all on table public.agent_task_dismissals to service_role;

create policy "members_read_own_agent_task_dismissals"
  on public.agent_task_dismissals for select to authenticated
  using (
    profile_id = auth.uid()
    and exists (
      select 1 from public.agent_tasks task
      where task.id = agent_task_dismissals.task_id
        and is_conversation_member(task.conversation_id)
    )
  );

create policy "members_clear_own_terminal_agent_tasks"
  on public.agent_task_dismissals for insert to authenticated
  with check (
    profile_id = auth.uid()
    and exists (
      select 1 from public.agent_tasks task
      where task.id = agent_task_dismissals.task_id
        and task.status in ('failed', 'completed', 'cancelled')
        and is_conversation_member(task.conversation_id)
    )
  );

comment on table public.agent_task_dismissals is
  'Per-profile Agent Work inbox dismissal state; canonical agent tasks remain durable.';

notify pgrst, 'reload schema';
