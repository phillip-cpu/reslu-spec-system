-- Record metadata-only OpenClaw Gateway lifecycle state for truthful live UI.
-- Tool arguments, tool results, prompts and assistant deltas are deliberately
-- excluded; canonical conversation messages and task artifacts remain the
-- only user-content stores.

alter table agent_conversation_jobs
  add column if not exists gateway_run_id text,
  add column if not exists progress_label text,
  add column if not exists progress_updated_at timestamptz;

alter table agent_tasks
  add column if not exists gateway_run_id text,
  add column if not exists progress_label text,
  add column if not exists progress_updated_at timestamptz;

alter table agent_conversation_jobs
  drop constraint if exists agent_conversation_jobs_gateway_run_id_length,
  add constraint agent_conversation_jobs_gateway_run_id_length
    check (gateway_run_id is null or char_length(gateway_run_id) between 1 and 160),
  drop constraint if exists agent_conversation_jobs_progress_label_length,
  add constraint agent_conversation_jobs_progress_label_length
    check (progress_label is null or char_length(progress_label) between 1 and 240);

alter table agent_tasks
  drop constraint if exists agent_tasks_gateway_run_id_length,
  add constraint agent_tasks_gateway_run_id_length
    check (gateway_run_id is null or char_length(gateway_run_id) between 1 and 160),
  drop constraint if exists agent_tasks_progress_label_length,
  add constraint agent_tasks_progress_label_length
    check (progress_label is null or char_length(progress_label) between 1 and 240);

comment on column agent_conversation_jobs.gateway_run_id is
  'Accepted local OpenClaw Gateway run id. Metadata only; never a provider token or prompt.';
comment on column agent_conversation_jobs.progress_label is
  'Bounded member-visible lifecycle label derived from safe Gateway event names; never tool arguments or results.';
comment on column agent_tasks.gateway_run_id is
  'Accepted local OpenClaw Gateway run id for durable task observability and cancellation.';
comment on column agent_tasks.progress_label is
  'Bounded member-visible lifecycle label derived from safe Gateway event names; never tool arguments or results.';
