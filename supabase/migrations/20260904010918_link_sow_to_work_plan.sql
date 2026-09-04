-- Durable provenance for work-plan tasks created or linked from a Scope of
-- Works revision. A task may summarise several room-level scope clauses, so
-- the source lines live in a join table rather than an array on board_tasks.
--
-- sow_work_key is an application-generated identity for one project phase +
-- trade package. It prevents double-clicks, retries and later SOW revisions
-- from creating duplicate active work tasks. sow_revision_id is the revision
-- most recently reviewed by a team member; comparing it with the current SOW
-- lets the UI flag a task for review without rewriting any authored task data.

alter table public.board_tasks
  add column if not exists sow_work_key text;

alter table public.board_tasks
  add column if not exists sow_revision_id uuid
    references public.sow_documents(id) on delete set null;

alter table public.board_tasks
  drop constraint if exists board_tasks_sow_work_key_length;
alter table public.board_tasks
  add constraint board_tasks_sow_work_key_length
    check (sow_work_key is null or char_length(sow_work_key) between 1 and 300);

create unique index if not exists uq_board_tasks_active_sow_work_key
  on public.board_tasks(project_id, sow_work_key)
  where deleted_at is null and sow_work_key is not null;

create index if not exists idx_board_tasks_sow_revision
  on public.board_tasks(sow_revision_id)
  where deleted_at is null and sow_revision_id is not null;

create table if not exists public.board_task_sow_lines (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.board_tasks(id) on delete cascade,
  sow_line_id uuid not null references public.sow_lines(id) on delete cascade,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint board_task_sow_lines_unique unique (task_id, sow_line_id)
);

create index if not exists idx_board_task_sow_lines_line
  on public.board_task_sow_lines(sow_line_id);

create index if not exists idx_board_task_sow_lines_creator
  on public.board_task_sow_lines(created_by)
  where created_by is not null;

alter table public.board_task_sow_lines enable row level security;

drop policy if exists "team_all" on public.board_task_sow_lines;
create policy "team_all" on public.board_task_sow_lines
  for all to authenticated using (true) with check (true);

-- Explicit grants are required for projects using Supabase's opt-in Data API
-- exposure model. RLS remains enabled as the row-access boundary.
revoke all on table public.board_task_sow_lines
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.board_task_sow_lines to authenticated, service_role;

comment on column public.board_tasks.sow_work_key is
  'Stable phase-and-trade identity for a Scope-derived work package. Unique among active tasks per project; used for retry-safe generation and revision refreshes.';
comment on column public.board_tasks.sow_revision_id is
  'Scope of Works revision most recently reviewed against this task. A newer current revision makes the task review-due but never silently rewrites it.';
comment on table public.board_task_sow_lines is
  'Many-to-many provenance between Work board tasks and the exact Scope of Works clauses reviewed into each task.';

-- One selected preview row is applied atomically: either the task metadata and
-- all source-line links land together, or none of them do. Existing task
-- titles, descriptions, dates, status, phase and explicit contractor choices
-- are intentionally preserved. The only fields refreshed on an existing task
-- are its SOW provenance and any currently-empty trade/contact defaults.
create or replace function public.apply_sow_work_plan_package(
  p_project_id uuid,
  p_sow_id uuid,
  p_work_key text,
  p_title text,
  p_trade_role text,
  p_phase_group_id uuid,
  p_line_ids uuid[],
  p_existing_task_id uuid default null
)
returns table(task_id uuid, outcome text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.board_tasks;
  v_column_id uuid;
  v_contact_id uuid;
  v_expected_line_count integer;
  v_valid_line_count integer;
  v_outcome text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if p_work_key is null or btrim(p_work_key) = '' or char_length(p_work_key) > 300 then
    raise exception 'Invalid work package key';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'Task title is required';
  end if;
  if p_trade_role is null or btrim(p_trade_role) = '' or char_length(btrim(p_trade_role)) > 120 then
    raise exception 'Trade role must be between 1 and 120 characters';
  end if;
  if p_phase_group_id is null then
    raise exception 'A Work-plan phase is required';
  end if;
  if not exists (
    select 1 from public.sow_documents
     where id = p_sow_id and project_id = p_project_id and deleted_at is null
  ) then
    raise exception 'Scope of Works revision does not belong to this project';
  end if;
  if p_phase_group_id is not null and not exists (
    select 1 from public.board_groups
     where id = p_phase_group_id and project_id = p_project_id
  ) then
    raise exception 'Work-plan phase does not belong to this project';
  end if;

  select count(distinct source_id)
    into v_expected_line_count
    from unnest(coalesce(p_line_ids, '{}'::uuid[])) as source(source_id);
  if v_expected_line_count = 0 then
    raise exception 'At least one Scope of Works line is required';
  end if;

  select count(distinct line.id)
    into v_valid_line_count
    from public.sow_lines line
    join public.sow_sections section on section.id = line.section_id
   where section.sow_id = p_sow_id
     and line.id = any(p_line_ids)
     and line.kind = 'inclusion'
     and lower(btrim(line.trade)) = lower(btrim(p_trade_role));
  if v_valid_line_count <> v_expected_line_count then
    raise exception 'One or more Scope of Works lines do not belong to this revision';
  end if;

  select assignment.contact_id
    into v_contact_id
    from public.project_trade_assignments assignment
   where assignment.project_id = p_project_id
     and assignment.role_key = lower(btrim(p_trade_role))
   limit 1;

  if p_existing_task_id is not null then
    select * into v_task
      from public.board_tasks
     where id = p_existing_task_id
       and project_id = p_project_id
       and deleted_at is null
     for update;
    if not found then
      raise exception 'Existing Work task does not belong to this project';
    end if;
    if v_task.sow_work_key is not null and v_task.sow_work_key <> p_work_key then
      raise exception 'Existing Work task is already linked to another Scope package';
    end if;
    v_outcome := case when v_task.sow_work_key is null then 'linked' else 'refreshed' end;
  else
    select * into v_task
      from public.board_tasks
     where project_id = p_project_id
       and sow_work_key = p_work_key
       and deleted_at is null
     for update;

    if found then
      v_outcome := 'refreshed';
    else
      select id into v_column_id
        from public.board_columns
       where project_id = p_project_id
       order by sort, created_at
       limit 1;
      if v_column_id is null then
        raise exception 'Work board has no status column';
      end if;

      begin
        insert into public.board_tasks (
          project_id,
          column_id,
          title,
          description,
          contact_id,
          phase_group_id,
          trade_role,
          trade_contact_inherited,
          sow_work_key,
          sow_revision_id,
          sort,
          created_by
        )
        values (
          p_project_id,
          v_column_id,
          btrim(p_title),
          'Built from the reviewed Scope of Works. Edit the task freely; future scope revisions are offered for review and never overwrite task details.',
          v_contact_id,
          p_phase_group_id,
          btrim(p_trade_role),
          v_contact_id is not null,
          p_work_key,
          p_sow_id,
          coalesce((
            select max(existing.sort) + 1000
              from public.board_tasks existing
             where existing.column_id = v_column_id and existing.deleted_at is null
          ), 0),
          v_user_id
        )
        returning * into v_task;
        v_outcome := 'created';
      exception when unique_violation then
        -- A concurrent retry won the partial unique index. Reuse it rather
        -- than creating a duplicate or reporting a false failure.
        select * into v_task
          from public.board_tasks
         where project_id = p_project_id
           and sow_work_key = p_work_key
           and deleted_at is null
         for update;
        if not found then raise; end if;
        v_outcome := 'refreshed';
      end;
    end if;
  end if;

  update public.board_tasks task
     set sow_work_key = p_work_key,
         sow_revision_id = p_sow_id,
         trade_role = coalesce(task.trade_role, btrim(p_trade_role)),
         contact_id = case
           when task.contact_id is null and v_contact_id is not null then v_contact_id
           else task.contact_id
         end,
         trade_contact_inherited = case
           when task.contact_id is null and v_contact_id is not null then true
           else task.trade_contact_inherited
         end
   where task.id = v_task.id
  returning * into v_task;

  delete from public.board_task_sow_lines link where link.task_id = v_task.id;
  insert into public.board_task_sow_lines (task_id, sow_line_id, created_by)
  select v_task.id, source.source_id, v_user_id
    from (
      select distinct source_id
        from unnest(p_line_ids) as line_ids(source_id)
    ) source;

  if v_outcome = 'created' then
    insert into public.board_task_assignees (task_id, profile_id)
    values (v_task.id, v_user_id)
    on conflict (task_id, profile_id) do nothing;
  end if;

  task_id := v_task.id;
  outcome := v_outcome;
  return next;
end;
$$;

revoke all on function public.apply_sow_work_plan_package(
  uuid, uuid, text, text, text, uuid, uuid[], uuid
) from public, anon;
grant execute on function public.apply_sow_work_plan_package(
  uuid, uuid, text, text, text, uuid, uuid[], uuid
) to authenticated, service_role;

comment on function public.apply_sow_work_plan_package(
  uuid, uuid, text, text, text, uuid, uuid[], uuid
) is
  'Atomically creates, links or refreshes one reviewed SOW-derived Work package. Preserves authored task fields and is retry-safe via board_tasks.sow_work_key.';

notify pgrst, 'reload schema';
