-- Atomically retain bounded OpenClaw usage with a specialist consultation's
-- canonical completion. The existing two-argument function remains available
-- during the bridge rollout and delegates no new authority.

create or replace function public.complete_conversation_agent_consultation(
  p_job_id uuid,
  p_body text,
  p_openclaw_usage jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  created_message_id uuid;
begin
  if p_openclaw_usage is not null
    and not public.is_valid_openclaw_usage(p_openclaw_usage)
  then
    raise exception 'invalid OpenClaw usage';
  end if;

  -- This call and the usage update share the caller's transaction. Any error
  -- rolls back the response message, job completion and usage together.
  created_message_id := public.complete_conversation_agent_consultation(
    p_job_id,
    p_body
  );

  if p_openclaw_usage is not null then
    update public.agent_conversation_jobs
    set openclaw_usage = p_openclaw_usage
    where id = p_job_id and status = 'done';
    if not found then
      raise exception 'specialist consultation usage completion lost its job';
    end if;
  end if;

  return created_message_id;
end;
$$;

revoke all on function public.complete_conversation_agent_consultation(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_conversation_agent_consultation(uuid,text,jsonb)
  to service_role;

comment on function public.complete_conversation_agent_consultation(uuid,text,jsonb) is
  'Atomically completes one owner-visible specialist response and retains bounded content-free OpenClaw usage. Service role only.';

notify pgrst, 'reload schema';
