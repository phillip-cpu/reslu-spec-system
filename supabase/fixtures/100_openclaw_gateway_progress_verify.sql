begin;

do $$
declare
  missing_columns text[];
begin
  select array_agg(required.column_name order by required.table_name, required.column_name)
  into missing_columns
  from (
    values
      ('agent_conversation_jobs', 'gateway_run_id'),
      ('agent_conversation_jobs', 'progress_label'),
      ('agent_conversation_jobs', 'progress_updated_at'),
      ('agent_tasks', 'gateway_run_id'),
      ('agent_tasks', 'progress_label'),
      ('agent_tasks', 'progress_updated_at')
  ) as required(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = required.table_name
      and column_info.column_name = required.column_name
  );

  if missing_columns is not null then
    raise exception 'FAIL: migration 100 columns are missing: %', missing_columns;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_conversation_jobs_gateway_run_id_length'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'agent_conversation_jobs_progress_label_length'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'agent_tasks_gateway_run_id_length'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'agent_tasks_progress_label_length'
  ) then
    raise exception 'FAIL: migration 100 bounded metadata constraints are missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_conversation_jobs'
      and policyname = 'members_read_agent_jobs'
      and 'authenticated' = any(roles)
  ) then
    raise exception 'FAIL: conversation progress is not protected by the existing member policy';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_tasks'
      and policyname = 'members_read_agent_tasks'
      and 'authenticated' = any(roles)
  ) then
    raise exception 'FAIL: task progress is not protected by the existing member policy';
  end if;
end;
$$;

select 'PASS — migration 100 Gateway progress metadata is bounded and member-scoped' as result;

rollback;
