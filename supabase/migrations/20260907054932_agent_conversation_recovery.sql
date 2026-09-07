-- Restore conversation-first agent collaboration, task steering, visible
-- failures and outcome telemetry. Browser roles receive only the minimum
-- explicit Data API grants; runtime writes remain service-role only.

alter table public.agent_conversation_jobs
  add column if not exists progress_message text;

alter table public.agent_conversation_jobs
  drop constraint if exists agent_conversation_jobs_progress_message_length,
  add constraint agent_conversation_jobs_progress_message_length
    check (progress_message is null or char_length(progress_message) <= 4000);

alter table public.agent_tasks
  add column if not exists steering_version integer not null default 0,
  add column if not exists processed_steering_version integer not null default 0;

alter table public.agent_tasks
  drop constraint if exists agent_tasks_steering_versions_valid,
  add constraint agent_tasks_steering_versions_valid check (
    steering_version >= 0
    and processed_steering_version >= 0
    and processed_steering_version <= steering_version
  );

create or replace function public.record_agent_task_steering()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  linked_task_id uuid;
begin
  if new.author_profile_id is null or not (new.metadata ? 'agent_task_id') then
    return new;
  end if;
  begin
    linked_task_id := (new.metadata->>'agent_task_id')::uuid;
  exception when invalid_text_representation then
    return new;
  end;
  update public.agent_tasks task
  set steering_version = task.steering_version + 1
  where task.id = linked_task_id
    and task.conversation_id = new.conversation_id
    and task.status in ('queued','running','awaiting_approval');
  if found then
    insert into public.agent_task_events(task_id,event_type,label,detail,metadata)
    values (
      linked_task_id,
      'progress',
      'New direction received',
      left(new.body, 4000),
      jsonb_build_object('message_id', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_record_agent_task_steering on public.conversation_messages;
create trigger trg_record_agent_task_steering
  after insert on public.conversation_messages
  for each row execute function public.record_agent_task_steering();

create or replace function public.cancel_realtime_voice_agent_jobs(
  p_conversation_id uuid,
  p_agent_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  if auth.uid() is null or not public.is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  update public.agent_conversation_jobs job
  set status = 'cancelled', completed_at = now()
  where job.conversation_id = p_conversation_id
    and job.agent_id = any(p_agent_ids)
    and job.status in ('pending','processing')
    and exists (
      select 1 from public.conversation_messages message
      where message.id = job.triggering_message_id
        and message.conversation_id = p_conversation_id
        and message.author_profile_id = auth.uid()
        and message.metadata->>'source' = 'voice'
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.cancel_realtime_voice_agent_jobs(uuid,uuid[]) from public, anon;
grant execute on function public.cancel_realtime_voice_agent_jobs(uuid,uuid[]) to authenticated;

create table if not exists public.agent_run_attempts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  job_id uuid references public.agent_conversation_jobs(id) on delete cascade,
  task_id uuid references public.agent_tasks(id) on delete cascade,
  agent_id uuid not null references public.conversation_agents(id) on delete restrict,
  attempt_number integer not null default 1 check (attempt_number > 0),
  model_name text,
  reasoning_level text,
  status text not null default 'processing' check (status in ('processing','completed','failed','cancelled')),
  context_manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(context_manifest) = 'object'),
  openclaw_usage jsonb check (openclaw_usage is null or public.is_valid_openclaw_usage(openclaw_usage)),
  error text check (error is null or char_length(error) <= 4000),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (num_nonnulls(job_id, task_id) = 1),
  unique (job_id, attempt_number)
);

create index if not exists agent_run_attempts_conversation_started_idx
  on public.agent_run_attempts(conversation_id, started_at desc);
alter table public.agent_run_attempts enable row level security;
revoke all on public.agent_run_attempts from public, anon, authenticated;
grant all on public.agent_run_attempts to service_role;

create table if not exists public.agent_outcome_feedback (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  outcome text not null check (outcome in ('useful','needs_work','finished_elsewhere')),
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, profile_id)
);

create index if not exists agent_outcome_feedback_conversation_created_idx
  on public.agent_outcome_feedback(conversation_id, created_at desc);
alter table public.agent_outcome_feedback enable row level security;

create policy "members_read_own_agent_outcome_feedback"
  on public.agent_outcome_feedback for select to authenticated
  using (profile_id = auth.uid() and public.is_conversation_member(conversation_id));
create policy "members_create_own_agent_outcome_feedback"
  on public.agent_outcome_feedback for insert to authenticated
  with check (
    profile_id = auth.uid()
    and public.is_conversation_member(conversation_id)
    and exists (
      select 1 from public.conversation_messages message
      where message.id = message_id
        and message.conversation_id = agent_outcome_feedback.conversation_id
        and message.author_agent_id is not null
    )
  );
create policy "members_update_own_agent_outcome_feedback"
  on public.agent_outcome_feedback for update to authenticated
  using (profile_id = auth.uid() and public.is_conversation_member(conversation_id))
  with check (
    profile_id = auth.uid()
    and public.is_conversation_member(conversation_id)
    and exists (
      select 1 from public.conversation_messages message
      where message.id = message_id
        and message.conversation_id = agent_outcome_feedback.conversation_id
        and message.author_agent_id is not null
    )
  );

revoke all on public.agent_outcome_feedback from public, anon;
grant select, insert, update on public.agent_outcome_feedback to authenticated;
grant all on public.agent_outcome_feedback to service_role;

create or replace function public.complete_agent_conversation_job(
  p_job_id uuid,
  p_body text,
  p_metadata jsonb,
  p_openclaw_usage jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job public.agent_conversation_jobs;
  message_id uuid;
begin
  if current_user not in ('postgres','service_role') then raise exception 'forbidden'; end if;
  select * into job from public.agent_conversation_jobs where id = p_job_id for update;
  if job.id is null then raise exception 'job not found'; end if;
  if job.status <> 'processing' then raise exception 'job is no longer processing'; end if;
  if nullif(btrim(coalesce(p_body,'')), '') is null or char_length(p_body) > 20000 then
    raise exception 'invalid agent message';
  end if;
  insert into public.conversation_messages(conversation_id,author_agent_id,body,metadata)
  values (job.conversation_id,job.agent_id,p_body,coalesce(p_metadata,'{}'::jsonb))
  returning id into message_id;
  update public.agent_conversation_jobs
  set status = 'done', completed_at = now(), error = null,
      openclaw_usage = p_openclaw_usage, progress_message = null
  where id = job.id;
  return message_id;
end;
$$;

revoke all on function public.complete_agent_conversation_job(uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.complete_agent_conversation_job(uuid,text,jsonb,jsonb) to service_role;

create or replace function public.fail_agent_conversation_job(
  p_job_id uuid,
  p_error text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  job public.agent_conversation_jobs;
  message_id uuid;
  safe_error text := left(coalesce(nullif(btrim(p_error),''),'Agent runtime failed'), 4000);
begin
  if current_user not in ('postgres','service_role') then raise exception 'forbidden'; end if;
  select * into job from public.agent_conversation_jobs where id = p_job_id for update;
  if job.id is null then raise exception 'job not found'; end if;
  if job.status not in ('pending','processing') then return null; end if;
  insert into public.conversation_messages(conversation_id,author_agent_id,kind,body,metadata)
  values (
    job.conversation_id,
    job.agent_id,
    'system',
    'I could not finish that turn. Your message is safe; please retry, or start a task if you want the work to continue in the background.',
    jsonb_build_object('source','agent_runtime_failure','job_id',job.id,'retryable',true)
  ) returning id into message_id;
  update public.agent_conversation_jobs
  set status = 'failed', completed_at = now(), error = safe_error, progress_message = null
  where id = job.id;
  return message_id;
end;
$$;

revoke all on function public.fail_agent_conversation_job(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_agent_conversation_job(uuid,text) to service_role;

comment on table public.agent_run_attempts is
  'Append-only runtime attempt telemetry. Retries create new rows instead of overwriting prior evidence.';
comment on table public.agent_outcome_feedback is
  'Explicit user outcome feedback for agent replies, distinct from social message reactions.';

notify pgrst, 'reload schema';
