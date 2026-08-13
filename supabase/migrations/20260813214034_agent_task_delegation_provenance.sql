-- Preserve bounded provenance for specialist work delegated by one RESLU
-- agent to another. Task execution remains asynchronous and all existing
-- approval boundaries continue to apply to the delegated owner.

alter table public.agent_tasks
  add column if not exists delegated_by_agent_id uuid
    references public.conversation_agents(id) on delete set null,
  add column if not exists source_task_id uuid
    references public.agent_tasks(id) on delete set null;

create index if not exists agent_tasks_source_task_idx
  on public.agent_tasks(source_task_id)
  where source_task_id is not null;

comment on column public.agent_tasks.delegated_by_agent_id is
  'Agent that requested this specialist task; null for human-created work.';
comment on column public.agent_tasks.source_task_id is
  'Optional parent durable task when delegation originated inside background work.';
