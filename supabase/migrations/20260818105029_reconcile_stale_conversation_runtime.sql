-- Recover runtime rows abandoned by a killed/restarted conversation worker.
-- Recovery is terminal and truthful: it never requeues work, replays an
-- approved action or invents a successful result. The existing requester-only
-- retry boundary remains the only path back from a failed durable task.

create or replace function reconcile_stale_conversation_runtime()
returns table (
  cancelled_tasks integer,
  failed_tasks integer,
  dropped_calls integer,
  cancelled_jobs integer,
  call_records integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cancelled_tasks integer := 0;
  v_failed_tasks integer := 0;
  v_dropped_calls integer := 0;
  v_cancelled_jobs integer := 0;
  v_call_records integer := 0;
begin
  with recovered as (
    update agent_tasks task
    set
      status = 'cancelled',
      completed_at = coalesce(task.completed_at, now()),
      error = null
    where task.status = 'running'
      and task.cancellation_requested_at is not null
      and task.cancellation_requested_at < now() - interval '2 minutes'
    returning task.id
  )
  insert into agent_task_events(task_id, event_type, label, metadata)
  select
    recovered.id,
    'cancelled',
    'Task cancelled after worker interruption',
    '{"recovery":true,"reason":"stale_worker_after_cancel"}'::jsonb
  from recovered;
  get diagnostics v_cancelled_tasks = row_count;

  with recovered as (
    update agent_tasks task
    set
      status = 'failed',
      completed_at = coalesce(task.completed_at, now()),
      error = 'Worker stopped before task completion. Review the task before retrying.'
    where task.status = 'running'
      and task.cancellation_requested_at is null
      and coalesce(task.progress_updated_at, task.updated_at, task.claimed_at, task.created_at)
        < now() - interval '30 minutes'
    returning task.id
  )
  insert into agent_task_events(task_id, event_type, label, detail, metadata)
  select
    recovered.id,
    'failed',
    'Task interrupted before completion',
    'The worker stopped reporting progress. Review this task before using its bounded retry action.',
    '{"recovery":true,"reason":"stale_worker"}'::jsonb
  from recovered;
  get diagnostics v_failed_tasks = row_count;

  update conversation_calls call
  set
    status = 'dropped',
    ended_at = coalesce(call.ended_at, now()),
    metadata = coalesce(call.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'active_call_recovery_reason', 'stale_active_watchdog',
        'active_call_recovered_at', now()
      )
  where call.status = 'active'
    and call.started_at < now() - interval '4 hours';
  get diagnostics v_dropped_calls = row_count;

  update agent_conversation_jobs job
  set
    status = 'cancelled',
    completed_at = coalesce(job.completed_at, now())
  where job.status in ('pending', 'processing')
    and exists (
      select 1
      from conversation_messages message
      join conversation_calls call
        on call.id::text = message.metadata->>'realtime_call_id'
      where message.id = job.triggering_message_id
        and call.status = 'dropped'
        and call.metadata->>'active_call_recovery_reason' = 'stale_active_watchdog'
    );
  get diagnostics v_cancelled_jobs = row_count;

  insert into conversation_messages(
    conversation_id,
    author_profile_id,
    kind,
    body,
    metadata
  )
  select
    call.conversation_id,
    call.started_by,
    'call_record',
    'Call recovered as dropped because it was left active without a live session.',
    jsonb_build_object(
      'call_id', call.id,
      'presentation', call.presentation,
      'status', 'dropped',
      'reason', 'stale_active_watchdog',
      'exact_end_time_available', false
    )
  from conversation_calls call
  where call.status = 'dropped'
    and call.metadata->>'active_call_recovery_reason' = 'stale_active_watchdog'
    and not exists (
      select 1
      from conversation_messages message
      where message.conversation_id = call.conversation_id
        and message.kind = 'call_record'
        and message.metadata->>'call_id' = call.id::text
    );
  get diagnostics v_call_records = row_count;

  return query select
    v_cancelled_tasks,
    v_failed_tasks,
    v_dropped_calls,
    v_cancelled_jobs,
    v_call_records;
end;
$$;

revoke all on function reconcile_stale_conversation_runtime() from public, anon, authenticated;
grant execute on function reconcile_stale_conversation_runtime() to service_role;

comment on function reconcile_stale_conversation_runtime() is
  'Service-only watchdog that terminally reconciles abandoned tasks/calls and cancels only late conversational output. It never requeues work or replays approved actions.';

-- Reconcile existing browser-era rows before restoring the one-active-call
-- invariant. A recent genuine call is deliberately not touched.
select * from reconcile_stale_conversation_runtime();

create unique index if not exists conversation_calls_one_active_per_starter
  on conversation_calls(started_by)
  where status = 'active';

notify pgrst, 'reload schema';
