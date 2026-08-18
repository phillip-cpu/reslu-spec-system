begin;

do $$
declare
  valid_usage jsonb := '{
    "schema_version": 1,
    "provider": "openai",
    "model": "gpt-5.6-terra",
    "input_tokens": 100,
    "output_tokens": 5,
    "cache_read_tokens": 20,
    "cache_write_tokens": 0,
    "total_tokens": 125,
    "cost_usd": 0.001
  }'::jsonb;
begin
  if not public.is_valid_openclaw_usage(valid_usage) then
    raise exception 'FAIL: valid content-free OpenClaw usage was rejected';
  end if;
  if public.is_valid_openclaw_usage(valid_usage || '{"prompt":"private"}'::jsonb) then
    raise exception 'FAIL: arbitrary content was accepted in OpenClaw usage';
  end if;
  if public.is_valid_openclaw_usage(jsonb_set(valid_usage, '{input_tokens}', '-1'::jsonb)) then
    raise exception 'FAIL: negative OpenClaw token count was accepted';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_conversation_jobs' and column_name = 'openclaw_usage'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_tasks' and column_name = 'openclaw_usage'
  ) then
    raise exception 'FAIL: OpenClaw usage columns are missing';
  end if;
end;
$$;

select 'PASS — OpenClaw usage is bounded and content-free' as result;

rollback;
