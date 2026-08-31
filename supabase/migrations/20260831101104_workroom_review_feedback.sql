-- A review is collaborative, not binary. Requesting changes returns the same
-- durable task to its agent with attributable feedback, while preserving the
-- old review pack in the audit trail. It never grants execution authority.

alter table public.agent_tasks
  drop constraint if exists agent_tasks_approval_state_check;
alter table public.agent_tasks
  add constraint agent_tasks_approval_state_check check (
    approval_state in ('none','pending','approved','rejected','changes_requested')
  );

alter table public.agent_task_artifacts
  drop constraint if exists agent_task_artifacts_status_check;
alter table public.agent_task_artifacts
  add constraint agent_task_artifacts_status_check check (
    status in ('draft','approved','rejected','changes_requested','published')
  );

alter table public.agent_task_events
  drop constraint if exists agent_task_events_event_type_check;
alter table public.agent_task_events
  add constraint agent_task_events_event_type_check check (
    event_type in (
      'created','queued','started','progress','artifact','approval_required',
      'approved','rejected','changes_requested','completed','failed','cancelled'
    )
  );

create or replace function public.request_agent_task_artifact_changes(
  p_conversation_id uuid,
  p_task_id uuid,
  p_artifact_id uuid,
  p_note text
)
returns public.agent_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.agent_tasks;
  artifact public.agent_task_artifacts;
  clean_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null or not public.is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if clean_note is null then raise exception 'Say what needs to change'; end if;
  if char_length(clean_note) > 2000 then raise exception 'review note is too long'; end if;

  select * into artifact from public.agent_task_artifacts
  where id = p_artifact_id and task_id = p_task_id and status = 'draft'
  for update;
  if artifact.id is null then raise exception 'draft artifact not found'; end if;

  update public.agent_task_artifacts
  set status = 'changes_requested'
  where id = artifact.id;

  update public.agent_tasks task
  set
    approval_state = 'changes_requested',
    approval_note = clean_note,
    approval_receipt_id = null,
    status = 'queued',
    claimed_at = null,
    completed_at = null,
    error = null
  where task.id = p_task_id
    and task.conversation_id = p_conversation_id
    and task.status = 'awaiting_approval'
  returning * into result;

  if result.id is null then raise exception 'task is not awaiting approval'; end if;

  insert into public.agent_task_events(task_id, event_type, label, detail, metadata)
  values (
    result.id,
    'changes_requested',
    'Changes requested',
    clean_note,
    jsonb_build_object('source_artifact_id', artifact.id)
  );
  return result;
end;
$$;

revoke all on function public.request_agent_task_artifact_changes(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.request_agent_task_artifact_changes(uuid,uuid,uuid,text) to authenticated;

notify pgrst, 'reload schema';
