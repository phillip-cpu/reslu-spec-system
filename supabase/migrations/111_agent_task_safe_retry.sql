-- Failed durable work is a deliberate dead-letter state. A human may requeue
-- the same task only when no approved consequential action was in flight.
-- Reusing the row preserves the canonical task and agent session; each
-- explicit attempt receives a distinct Gateway idempotency identity, and
-- the bridge never creates a second task or silently retries on its own.

alter table agent_tasks
  add column if not exists retry_count integer not null default 0
  check (retry_count between 0 and 3);

create or replace function retry_failed_agent_task(
  p_conversation_id uuid,
  p_task_id uuid
)
returns agent_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  current_task agent_tasks;
  result agent_tasks;
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  select * into current_task
  from agent_tasks task
  where task.id = p_task_id
    and task.conversation_id = p_conversation_id
    and task.requested_by = auth.uid()
  for update;

  if current_task.id is null then
    raise exception 'task not found';
  end if;
  if current_task.status <> 'failed' then
    raise exception 'task is not failed';
  end if;
  if current_task.approval_state = 'approved' then
    raise exception 'approved task cannot be retried automatically';
  end if;
  if current_task.cancellation_requested_at is not null then
    raise exception 'cancelled task cannot be retried';
  end if;
  if current_task.retry_count >= 3 then
    raise exception 'task retry limit reached';
  end if;

  update agent_tasks task
  set
    status = 'queued',
    retry_count = task.retry_count + 1,
    claimed_at = null,
    completed_at = null,
    result_summary = null,
    model_name = null,
    error = null,
    gateway_run_id = null,
    progress_label = null,
    progress_updated_at = null
  where task.id = current_task.id
  returning * into result;

  insert into agent_task_events(task_id, event_type, label, metadata)
  values (
    result.id,
    'queued',
    'Task queued again',
    jsonb_build_object('recovery', true)
  );

  return result;
end;
$$;

revoke all on function retry_failed_agent_task(uuid, uuid) from public, anon;
grant execute on function retry_failed_agent_task(uuid, uuid) to authenticated;

comment on function retry_failed_agent_task(uuid, uuid) is
  'Explicit requester-only recovery for failed, unapproved durable work. Reuses the canonical task id, creates a distinct bounded attempt, and never retries an approved external action.';

notify pgrst, 'reload schema';
